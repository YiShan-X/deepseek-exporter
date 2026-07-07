// ==UserScript==
// @name         DeepSeek History Exporter
// @name:zh-CN   DeepSeek 对话历史导出
// @namespace    https://github.com/local/deepseek-exporter
// @version      1.2.4
// @description  在 chat.deepseek.com 上导出你自己的对话历史为 JSON / Markdown。数据仅留在本地，不上传任何外部服务器。
// @description:zh-CN  在 chat.deepseek.com 上导出你自己的对话历史为 JSON / Markdown。本地运行，无外联。
// @author       local
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.ico
// @grant        unsafeWindow
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * DeepSeek History Exporter — Tampermonkey Userscript
   * 单文件版（manifest 不需要、background 不需要、popup 不需要）
   * 用 unsafeWindow 注入页面的真实 window，hook 它的 fetch 即可
   * ============================================================ */
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  if (W.__DS_EXPORTER_LOADED__) return;
  W.__DS_EXPORTER_LOADED__ = true;

  /* -------- 全局状态（内存） -------- */
  let bearerToken = null;
  let capturedAt  = null;
  let userCache   = null;

  /* -------- 1. Hook fetch（拦截 Authorization 头） -------- */
  const origFetch = W.fetch;
  function readHeaders(headers) {
    if (!headers) return {};
    if (headers instanceof Headers)  return Object.fromEntries(headers.entries());
    if (Array.isArray(headers))      return Object.fromEntries(headers);
    if (typeof headers === 'object') return headers;
    return {};
  }
  W.fetch = async function patchedFetch(input, init) {
    try {
      if (typeof input === 'string' && input.indexOf('/api/v0/') !== -1) {
        const h = readHeaders(init && init.headers);
        const auth = h.authorization || h.Authorization;
        if (auth && auth.indexOf('Bearer ') === 0) {
          bearerToken = auth;
          capturedAt  = Date.now();
        }
      }
    } catch (_) {}
    return origFetch.apply(this, arguments);
  };

  /* -------- 2. 兜底 Hook XHR -------- */
  try {
    const xhrSet = W.XMLHttpRequest.prototype.setRequestHeader;
    W.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try {
        if (name && name.toLowerCase() === 'authorization' && /^Bearer\s+/.test(value)) {
          bearerToken = value;
          capturedAt  = Date.now();
        }
      } catch (_) {}
      return xhrSet.call(this, name, value);
    };
  } catch (_) {}

  /* -------- 3. API 客户端（用页面原生 fetch，自动带 Cookie） -------- */
  /**
   * API 客户端：调用只读接口
   * v1.1.1 增强：
   *   - 每次调用前后打 console.log + 时间戳，便于在卡死时定位
   *   - 单次调用 15s AbortController 超时，避免 token 失效 / 网络卡死时永远挂起
   */
  async function api(path, opts) {
    opts = opts || {};
    if (!bearerToken) throw new Error('尚未捕获到 Bearer Token，请在页面里点击几下对话触发 fetch');
    const url = path.indexOf('http') === 0 ? path : 'https://chat.deepseek.com' + path;
    const method = opts.method || 'GET';
    const TIMEOUT_MS = 15000;

    const t0 = Date.now();
    console.log('%c[DS-Exporter] → ' + method + ' ' + path, 'color:#4f46e5');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let resp;
    try {
      resp = await origFetch.call(W, url, {
        method: method,
        credentials: 'include',
        signal: ac.signal,
        headers: Object.assign(
          {
            accept: 'application/json',
            authorization: bearerToken,
            'x-client-platform': 'web',
            'x-client-version': '2.2.0',
            'x-client-locale': 'zh_CN',
            'x-client-bundle-id': 'com.deepseek.chat',
            referer: W.location.href,
          },
          opts.headers || {}
        ),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      console.error('[DS-Exporter] ✗ ' + method + ' ' + path + ' 失败 (' + ms + 'ms):', e && e.message || e);
      if (e && (e.name === 'AbortError' || String(e.message).toLowerCase().includes('aborted'))) {
        throw new Error(method + ' ' + path + ' 超时（' + TIMEOUT_MS + 'ms）—— token 可能已失效，刷新页面后重试');
      }
      throw new Error(method + ' ' + path + ' 网络错误: ' + (e && e.message || String(e)));
    }
    clearTimeout(timer);

    const ms = Date.now() - t0;
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error('[DS-Exporter] ✗ ' + method + ' ' + path + ' ' + resp.status +
                    ' (' + ms + 'ms) ' + (txt.slice(0, 80)));
      throw new Error('HTTP ' + resp.status + ' ' + resp.statusText + ' ← ' + path +
                      (txt ? ' / ' + txt.slice(0, 120) : ''));
    }
    console.log('%c[DS-Exporter] ✓ ' + method + ' ' + path + ' ' + resp.status +
                ' (' + ms + 'ms)', 'color:#15803d');
    return resp.json();
  }

  /* -------- 4. 只读接口 -------- */
  async function getCurrentUser() {
    const r = await api('/api/v0/users/current');
    return (r && r.data && r.data.biz_data) || null;
  }

  /**
   * 全量分页拉取所有会话（v1.2.3 加 limit 参数：测试用，只取前 N 个）
   * 关键变更（v1.1.0）：
   *   - 不依赖服务器返回的 has_more / next_cursor（猜测字段名）
   *   - 改用 keyset cursor：从上一页最后一项构造 lte_cursor.{pinned,updated_at,id}
   *   - 终止条件（任一）：
   *       (a) 本页 < page_size        ─── 已经是最后一页
   *       (b) bz.has_more === false   ─── 服务器明确告诉结束
   *       (c) 全部重复 (added==0)     ─── 游标失效自保
   *       (d) 页数 > 200              ─── 20000 兜底，防止死循环
   *       (e) limit > 0 && out.length >= limit   ─── 测试模式到顶就停
   *   - seenIds 去重，配合 onProgress 实时反馈
   */
  async function listAllSessions(onProgress, limit) {
    onProgress = onProgress || function () {};
    const hardLimit = (typeof limit === 'number' && limit > 0) ? limit : Infinity;
    const out = [];
    const seenIds = new Set();
    let lastSession = null;
    let pageNo = 0;

    while (true) {
      pageNo += 1;
      if (pageNo > 200) break; // 20000 sessions 硬护栏

      const params = new URLSearchParams();
      params.set('page_size', '100');
      if (lastSession) {
        // 用上一页最后一项构造 keyset cursor
        params.set('lte_cursor.pinned', String(lastSession.pinned || false));
        if (lastSession.updated_at != null) {
          params.set('lte_cursor.updated_at', String(lastSession.updated_at));
        }
        if (lastSession.id) {
          params.set('lte_cursor.id', lastSession.id);
        }
      } else {
        params.set('lte_cursor.pinned', 'false');
      }

      const r = await api('/api/v0/chat_session/fetch_page?' + params.toString());
      const bz = (r && r.data && r.data.biz_data) || {};
      const batch = bz.chat_sessions || [];
      if (batch.length === 0) break;

      let addedCount = 0;
      let hitLimit = false;
      for (const s of batch) {
        if (!seenIds.has(s.id)) {
          seenIds.add(s.id);
          out.push(s);
          addedCount++;
          // 测试模式：单条添加后立即检测，到上限就停
          if (out.length >= hardLimit) {
            hitLimit = true;
            break;
          }
        }
      }
      if (addedCount > 0) lastSession = batch[batch.length - 1];

      // 进度回调
      onProgress({
        page: pageNo,
        total: out.length,
        pageSize: batch.length,
        serverHasMore: bz.has_more,
      });

      // 终止判断
      if (hitLimit) break;                  // (e) 测试模式到达指定上限
      if (batch.length < 100) break;        // (a) 不满一页 = 最后一页
      if (bz.has_more === false) break;     // (b) 服务器明确结束
      if (addedCount === 0) break;          // (c) 游标失效

      await sleep(300);
    }
    return out;
  }

  async function getHistory(chatSessionId) {
    const r = await api('/api/v0/chat/history_messages?chat_session_id=' +
                        encodeURIComponent(chatSessionId));
    return ((r && r.data && r.data.biz_data && r.data.biz_data.chat_messages) || []);
  }

  /** 从 URL 解析当前会话 ID，例如 /a/chat/s/fa5d16f5-... */
  function getCurrentSessionId() {
    try {
      const m = W.location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{16,})/i);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  /** 单会话导出（适合测试 / 当前页面调试） */
  async function exportCurrent(chatSessionId, onProgress) {
    onProgress = onProgress || function () {};
    onProgress({ stage: 'user', message: '校验登录...' });
    const me = userCache || (userCache = await getCurrentUser());

    onProgress({ stage: 'list', message: '跳过列表（单会话模式）' });

    onProgress({ stage: 'fetch', total: 1, current: 0, title: '(当前对话)' });
    const msgs = await getHistory(chatSessionId);

    return {
      meta: {
        exportedAt: new Date().toISOString(),
        user: {
          id:       me.id,
          email:    me.email,
          mobile:   me.mobile_number,
          provider: me.id_profile && me.id_profile.provider,
          name:     me.id_profile && me.id_profile.name,
          avatar:   me.id_profile && me.id_profile.picture,
        },
        totalSessions: 1,
        scope: 'current',
        currentSessionId: chatSessionId,
      },
      sessions: [{
        id: chatSessionId,
        title: '(当前对话)',
        title_type: 'CURRENT',
        pinned: false,
        model_type: null,
        updated_at: null,
        message_count: msgs.length,
        messages: msgs,
      }],
    };
  }

  /* -------- 5. 主流程 -------- */
  /**
   * 全量导出主流程
   * @param {function} onProgress
   * @param {number} [limit] 可选——只取前 N 个会话（测试模式）
   */
  async function exportAll(onProgress, limit) {
    onProgress = onProgress || function () {};
    onProgress({ stage: 'user', message: '校验登录...' });
    const me = await getCurrentUser();
    userCache = me;

    onProgress({
      stage: 'list',
      message: (limit && limit > 0) ? ('拉取会话列表（前 ' + limit + ' 个）...') : '拉取会话列表...',
    });
    const sessions = await listAllSessions((p) => {
      onProgress({
        stage: 'list_page',
        page: p.page,
        total: p.total,
        pageSize: p.pageSize,
        serverHasMore: p.serverHasMore,
        message: '第 ' + p.page + ' 页 · 已拉 ' + p.total + ' 个会话（每页 ' + p.pageSize + '）',
      });
    }, limit);

    const out = {
      meta: {
        exportedAt: new Date().toISOString(),
        user: {
          id:       me.id,
          email:    me.email,
          mobile:   me.mobile_number,
          provider: me.id_profile && me.id_profile.provider,
          name:     me.id_profile && me.id_profile.name,
          avatar:   me.id_profile && me.id_profile.picture,
        },
        totalSessions: sessions.length,
        scope: 'all',
        limit: (limit && limit > 0) ? limit : null,
      },
      sessions: [],
    };

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      onProgress({ stage: 'fetch', total: sessions.length, current: i, title: s.title });
      try {
        const msgs = await getHistory(s.id);
        out.sessions.push({
          id: s.id,
          title: s.title,
          title_type: s.title_type,
          pinned: s.pinned,
          model_type: s.model_type,
          updated_at: s.updated_at,
          message_count: msgs.length,
          messages: msgs,
        });
      } catch (e) {
        out.sessions.push({
          id: s.id,
          title: s.title,
          updated_at: s.updated_at,
          error: e.message,
          messages: [],
        });
      }
      if (i % 5 === 4) await sleep(800);
      else             await sleep(150);
    }
    onProgress({ stage: 'done', total: sessions.length, current: sessions.length });
    return out;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================================================
   * UI 部分：右下角浮窗按钮 + 模态面板
   * ============================================================ */
  GM_addStyle(`
    #ds-exp-fab {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      width: 48px; height: 48px; border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #fff; font-size: 22px; line-height: 48px; text-align: center;
      cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25);
      user-select: none; transition: transform .15s ease;
    }
    #ds-exp-fab:hover { transform: scale(1.08); }
    #ds-exp-fab:active { transform: scale(.95); }
    #ds-exp-modal-back {
      position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 2147483647;
      display: none; align-items: center; justify-content: center;
      font-family: -apple-system, system-ui, "Segoe UI", "PingFang SC",
                   "Microsoft YaHei", sans-serif;
    }
    #ds-exp-modal-back.show { display: flex; }
    #ds-exp-modal {
      width: 460px; max-width: calc(100vw - 24px);
      background: #fff; border-radius: 12px; box-shadow: 0 12px 48px rgba(0,0,0,.3);
      overflow: hidden;
    }
    #ds-exp-modal header {
      padding: 16px 20px; display: flex; align-items: center; justify-content: space-between;
      background: linear-gradient(135deg, #4f46e5, #7c3aed); color: #fff;
    }
    #ds-exp-modal header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    #ds-exp-modal header .sub { font-size: 11px; opacity: .85; margin-top: 2px; }
    #ds-exp-modal header button.close {
      background: transparent; border: 0; color: #fff; font-size: 20px;
      line-height: 1; cursor: pointer; padding: 4px 8px;
    }
    #ds-exp-modal .body { padding: 16px 20px; }
    #ds-exp-userBox {
      padding: 10px 12px; border-radius: 8px; font-size: 13px;
      display: flex; align-items: center; gap: 8px;
    }
    #ds-exp-userBox.unknown { background: #fff8e1; color: #8d6e00; }
    #ds-exp-userBox.ok      { background: #e8f5e9; color: #2e7d32; }
    #ds-exp-userBox.err     { background: #ffebee; color: #c62828; }
    #ds-exp-userBox .dot {
      width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .65;
    }
    #ds-exp-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; margin: 14px 0 6px; }
    #ds-exp-stats .stat {
      background: #f3f4f6; border-radius: 8px; padding: 10px 6px; text-align: center;
    }
    #ds-exp-stats .stat .num { display: block; font-size: 16px; font-weight: 700; color: #4f46e5; }
    #ds-exp-stats .stat .lbl { font-size: 10px; color: #888; }
    .ds-exp-row { margin-top: 14px; }
    .progressWrap {
      height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden;
    }
    #ds-exp-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #4f46e5, #7c3aed); transition: width .25s; }
    #ds-exp-progressText { font-size: 12px; color: #555; margin-top: 8px; min-height: 18px; }
    .ds-exp-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
    .ds-exp-actions button {
      padding: 10px 12px; border: 0; border-radius: 6px; cursor: pointer;
      font-size: 13px; font-weight: 500;
    }
    .ds-exp-actions button.primary { background: #4f46e5; color: #fff; }
    .ds-exp-actions button.secondary { background: #e5e7eb; color: #1f2937; }
    /* disabled 状态同时压背景色 + 文字色，不只靠 opacity（紫色按钮在 0.45 opacity 下还是太显眼） */
    .ds-exp-actions button:disabled {
      background: #e2e8f0 !important;
      color: #94a3b8 !important;
      cursor: not-allowed;
      box-shadow: none;
    }
    #ds-exp-log {
      margin-top: 12px; padding: 8px 10px; background: #f9fafb; border-radius: 6px;
      font-size: 11px; color: #555; max-height: 110px; overflow: auto;
      white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace;
    }
    .curHint {
      margin-top: 10px; padding: 6px 10px; background: #eef2ff; border-radius: 6px;
      font-size: 11px; color: #3730a3;
    }
    .curHint code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
    .ds-exp-footer {
      padding: 10px 20px; font-size: 10px; color: #aaa; text-align: center;
      border-top: 1px solid #eee;
    }
  `);

  // 注入 UI
  function ensureUI() {
    if (document.getElementById('ds-exp-fab')) return;

    const fab = document.createElement('div');
    fab.id = 'ds-exp-fab';
    fab.textContent = '📥';
    fab.title = 'DeepSeek 对话导出';
    fab.addEventListener('click', openModal);

    const back = document.createElement('div');
    back.id = 'ds-exp-modal-back';
    back.innerHTML = `
      <div id="ds-exp-modal" role="dialog" aria-label="DeepSeek 历史导出">
        <header>
          <div>
            <h2>DeepSeek 历史导出</h2>
            <div class="sub">仅本地浏览器执行 · 无任何外联</div>
          </div>
          <button class="close" aria-label="关闭">×</button>
        </header>
        <div class="body">
          <div id="ds-exp-userBox" class="unknown">
            <span class="dot"></span><span id="ds-exp-userText">检查登录状态…</span>
          </div>

          <div id="ds-exp-stats" style="display:none">
            <div class="stat"><span class="num" id="ds-exp-statTotal">—</span><span class="lbl">对话数</span></div>
            <div class="stat"><span class="num" id="ds-exp-statMsgs">—</span><span class="lbl">消息条数</span></div>
            <div class="stat"><span class="num" id="ds-exp-statSize">—</span><span class="lbl">预估 KB</span></div>
          </div>

          <div class="ds-exp-row">
            <div class="progressWrap"><div id="ds-exp-bar"></div></div>
            <div id="ds-exp-progressText">准备就绪</div>
          </div>

          <div class="ds-exp-actions">
            <button id="ds-exp-exportJson" class="primary" disabled>全量合并 1 个 JSON</button>
            <button id="ds-exp-exportMd"   class="secondary" disabled>全量合并 1 个 Markdown</button>
          </div>

          <div class="ds-exp-actions" style="margin-top:6px">
            <button id="ds-exp-exportZipJson" class="secondary" disabled title="把全部会话逐个封装为 .json 再打包 zip">📦 全量逐个 ZIP (JSON)</button>
            <button id="ds-exp-exportZipMd"   class="secondary" disabled title="把全部会话逐个封装为 .md 再打包 zip">📦 全量逐个 ZIP (Markdown)</button>
          </div>

          <div class="ds-exp-actions" style="margin-top:6px">
            <button id="ds-exp-exportCurJson" class="secondary" disabled title="只导出当前页打开的对话（单会话，几乎瞬时）">⚡ 当前 1 个 JSON</button>
            <button id="ds-exp-exportCurMd"   class="secondary" disabled title="只导出当前页打开的对话（单会话，几乎瞬时）">⚡ 当前 1 个 Markdown</button>
          </div>

          <div class="ds-exp-actions" style="margin-top:6px">
            <button id="ds-exp-exportTestZipJson" class="secondary" disabled title="跑前 5 个会话做 zip 测试，几秒出结果，验证格式无误再跑全量">🧪 测试 ZIP (前 5 个 JSON)</button>
            <button id="ds-exp-exportTestZipMd"   class="secondary" disabled title="跑前 5 个会话做 zip 测试，几秒出结果，验证格式无误再跑全量">🧪 测试 ZIP (前 5 个 MD)</button>
          </div>

          <div id="ds-exp-curHint" class="curHint" style="display:none">
            📌 检测到当前对话 ID：<code id="ds-exp-curId"></code>
          </div>

          <div id="ds-exp-log"></div>
        </div>
        <div class="ds-exp-footer">v1.2.4 · Tampermonkey · 仅作用于 chat.deepseek.com</div>
      </div>
    `;
    back.querySelector('.close').addEventListener('click', () => back.classList.remove('show'));
    back.addEventListener('click', (e) => { if (e.target === back) back.classList.remove('show'); });

    (document.body || document.documentElement).appendChild(fab);
    (document.body || document.documentElement).appendChild(back);

    document.getElementById('ds-exp-exportJson').addEventListener('click', () => doExport('json', 'all', 'merged'));
    document.getElementById('ds-exp-exportMd').addEventListener('click',   () => doExport('md',   'all', 'merged'));
    document.getElementById('ds-exp-exportZipJson').addEventListener('click', () => doExport('json', 'all', 'zip'));
    document.getElementById('ds-exp-exportZipMd').addEventListener('click',   () => doExport('md',   'all', 'zip'));
    document.getElementById('ds-exp-exportTestZipJson').addEventListener('click', () => doExport('json', 'all', 'zip', 5));
    document.getElementById('ds-exp-exportTestZipMd').addEventListener('click',   () => doExport('md',   'all', 'zip', 5));
    document.getElementById('ds-exp-exportCurJson').addEventListener('click', () => doExport('json', 'current', 'merged'));
    document.getElementById('ds-exp-exportCurMd').addEventListener('click',   () => doExport('md',   'current', 'merged'));

    // 监听 SPA 路由变化，更新「当前对话」按钮可用性
    updateCurrentBtns();
    setInterval(updateCurrentBtns, 800);
    W.addEventListener('popstate', updateCurrentBtns);
    // SPA navigation via pushState/replaceState
    const _ps = W.history.pushState;
    W.history.pushState = function () { const r = _ps.apply(this, arguments); setTimeout(updateCurrentBtns, 50); return r; };
    const _rs = W.history.replaceState;
    W.history.replaceState = function () { const r = _rs.apply(this, arguments); setTimeout(updateCurrentBtns, 50); return r; };
  }

  /** 根据 URL 启用/禁用「⚡ 当前」按钮 */
  function updateCurrentBtns() {
    const sid = getCurrentSessionId();
    const jsonBtn = document.getElementById('ds-exp-exportCurJson');
    const mdBtn   = document.getElementById('ds-exp-exportCurMd');
    const hint    = document.getElementById('ds-exp-curHint');
    const idEl    = document.getElementById('ds-exp-curId');
    if (!jsonBtn || !mdBtn) return;

    if (sid) {
      jsonBtn.disabled = false;
      mdBtn.disabled   = false;
      if (hint && idEl) {
        hint.style.display = 'block';
        idEl.textContent = sid;
      }
    } else {
      jsonBtn.disabled = true;
      mdBtn.disabled   = true;
      if (hint) hint.style.display = 'none';
    }
  }

  // 等 document.body 就绪
  if (document.body) ensureUI();
  else {
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); ensureUI(); }
    });
    obs.observe(document.documentElement, { childList: true });
  }

  function openModal() {
    const back = document.getElementById('ds-exp-modal-back');
    if (!back) return;
    back.classList.add('show');
    checkAuth();
  }

  function setLog(line) {
    const el = document.getElementById('ds-exp-log');
    if (!el) return;
    const t = new Date().toLocaleTimeString();
    el.textContent = '[' + t + '] ' + line + '\n' + el.textContent;
  }

  function setUserState(kind, msg) {
    const box = document.getElementById('ds-exp-userBox');
    const txt = document.getElementById('ds-exp-userText');
    if (!box || !txt) return;
    box.className = kind;
    if (kind === 'ok') {
      txt.innerHTML = '✓ ' + msg;
    } else {
      txt.textContent = msg;
    }
  }

  function setProgress(pct, text) {
    const bar = document.getElementById('ds-exp-bar');
    const pt  = document.getElementById('ds-exp-progressText');
    if (bar) bar.style.width = (pct == null ? 0 : pct) + '%';
    if (pt && text != null) pt.textContent = text;
  }

  async function checkAuth() {
    if (!bearerToken) {
      setUserState('unknown', 'Token 未捕获，请在页面里点击几下对话');
      return;
    }
    try {
      if (!userCache) userCache = await getCurrentUser();
      const u = userCache;
      setUserState(
        'ok',
        (u.id_profile && u.id_profile.name) || '已登录' +
          ' <small style="color:#888">(' + (u.email || u.mobile_number || u.id) + ')</small>'
      );
      document.getElementById('ds-exp-exportJson').disabled       = false;
      document.getElementById('ds-exp-exportMd').disabled         = false;
      document.getElementById('ds-exp-exportZipJson').disabled   = false;
      document.getElementById('ds-exp-exportZipMd').disabled     = false;
      document.getElementById('ds-exp-exportTestZipJson').disabled = false;
      document.getElementById('ds-exp-exportTestZipMd').disabled   = false;
    } catch (e) {
      setUserState('err', '校验失败：' + e.message);
    }
  }

  /**
   * 提取消息文本——兼容多种字段布局
   * DeepSeek 不同版本/不同消息类型可能用：content_blocks / content /
   *   message_content / parts / body / text / raw_content …
   * 全部 miss 时把整条消息作为 JSON 兜底输出，方便排查
   */
  function extractText(msg) {
    if (!msg || typeof msg !== 'object') return '';

    // 辅助：判断一个对象是否「长得像内容块」
    function blocksToMd(blocks) {
      if (!Array.isArray(blocks) || blocks.length === 0) return '';
      return blocks.map((b) => {
        if (b == null) return '';
        if (typeof b === 'string') return b;
        if (typeof b !== 'object') return String(b);
        const t = b.type || b.kind || b.role || '';
        if (t === 'text' || t === 'TEXT' || !t) {
          return b.text || b.content || b.value || b.data || JSON.stringify(b, null, 2);
        }
        if (/think/i.test(t)) {
          const v = b.thinking || b.text || b.content || b.value || JSON.stringify(b, null, 2);
          return '> **思考过程**：\n> ' + String(v).replace(/\n/g, '\n> ');
        }
        if (/tool[_-]?call/i.test(t)) {
          return '```json\n' + JSON.stringify({
            tool: b.tool || b.name, args: b.args || b.arguments || b.input,
            call_id: b.call_id || b.id,
          }, null, 2) + '\n```';
        }
        if (/tool[_-]?result/i.test(t)) {
          return '<details><summary>工具结果</summary>\n\n```json\n' +
                 JSON.stringify(b.result || b.output || b, null, 2) + '\n```\n\n</details>';
        }
        if (t === 'image' || /^image/i.test(t)) {
          return '![image](' + (b.url || b.src || b.image_url || '') + ')';
        }
        if (t === 'file' || /^file/i.test(t)) {
          return '📎 ' + (b.name || b.filename || b.url || '');
        }
        // 未知类型 — 整段 JSON
        return '```json\n' + JSON.stringify(b, null, 2) + '\n```';
      }).filter(Boolean).join('\n\n');
    }

    // 候选字段名（按优先级）
    const candidates = [
      'content_blocks',  // DeepSeek 当前主流
      'blocks',
      'message_content',
      'content_parts',
      'parts',           // ChatGPT 风
      'segments',
      'content',
      'body',
      'text',
      'message',
      'raw_content',
    ];

    for (const key of candidates) {
      const v = msg[key];
      if (v == null || v === '') continue;
      if (typeof v === 'string')   { if (v.trim()) return v; continue; }
      if (Array.isArray(v))        { const m = blocksToMd(v); if (m) return m; continue; }
      if (typeof v === 'object')   { const m = blocksToMd([v]); if (m) return m; continue; }
    }

    // 全部 miss — 整条消息 dump JSON（不含 metadata 噪音）
    const skip = new Set(['id','chat_session_id','role','created_at','updated_at',
                          'model_type','parent_id','token_count','finish_reason',
                          'status','seq','index']);
    const filtered = {};
    for (const k of Object.keys(msg)) {
      if (!skip.has(k)) filtered[k] = msg[k];
    }
    if (Object.keys(filtered).length === 0) {
      return '_(消息体为空：' + Object.keys(msg).join(', ') + ')_';
    }
    return '```json\n' + JSON.stringify(filtered, null, 2) + '\n```';
  }

  /** 在控制台打印第一条样本消息的完整结构，便于排查 schema */
  async function probeFirstMsg() {
    if (!bearerToken) return;
    try {
      console.groupCollapsed('%c[DS-Exporter] Probe 第一个会话的消息结构', 'color:#4f46e5;font-weight:bold');
      const me = await getCurrentUser();
      const sessions = await listAllSessions();
      if (!sessions.length) { console.warn('没有会话'); console.groupEnd(); return; }
      const s0 = sessions[0];
      console.log('Session[0]:', { id: s0.id, title: s0.title, model_type: s0.model_type, updated_at: s0.updated_at });
      const msgs = await getHistory(s0.id);
      console.log('msg count:', msgs.length);
      for (let i = 0; i < Math.min(3, msgs.length); i++) {
        console.log(`msg[${i}] keys:`, msgs[i] ? Object.keys(msgs[i]) : 'null');
        console.log(`msg[${i}] full:`, msgs[i]);
      }
      console.groupEnd();
    } catch (e) {
      console.error('[DS-Exporter] probe failed:', e);
    }
  }

  function toMarkdown(d) {
    const lines = [];
    lines.push('# DeepSeek 对话历史导出');
    lines.push('');
    lines.push('- 导出时间：' + d.meta.exportedAt);
    lines.push('- 用户：' + (d.meta.user.name || '') +
                ' (' + (d.meta.user.email || d.meta.user.mobile || '') + ')');
    lines.push('- 共 **' + d.sessions.length + '** 条会话');
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const s of d.sessions) {
      lines.push('## ' + (s.title || '(无标题)'));
      lines.push('');
      lines.push('- Session ID: `' + s.id + '`');
      lines.push('- 类型：' + s.title_type + ' · 模型：' + s.model_type +
                  ' · 置顶：' + (s.pinned ? '是' : '否'));
      lines.push('- 更新：' + new Date(s.updated_at * 1000).toISOString());
      lines.push('- 消息数：' + s.message_count);
      if (s.error) lines.push('- ⚠️ 错误：' + s.error);
      lines.push('');
      if (s.messages && s.messages.length) {
        for (const m of s.messages) {
          const role = m.role === 'USER' ? '👤 User'
                     : (m.role === 'ASSISTANT' ? '🤖 Assistant'
                     : '⚙️ ' + m.role);
          const ts = m.created_at ? new Date(m.created_at * 1000).toISOString() : '';
          lines.push('### ' + role + ' · ' + ts);
          lines.push('');
          lines.push(extractText(m));
          lines.push('');
        }
      } else {
        lines.push('_（无消息）_');
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  function dateStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
           '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ============================================================
   * v1.2.0 — ZIP 打包（一会话一文件）
   * 内联 STORE-only zip 写入器，零依赖、无 JSZip
   *   - CRC32（按 IEEE 802.3，未压缩）
   *   - Local file header + Central directory + EOCD
   * ============================================================ */
  const _CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0 ^ (-1);
    for (let i = 0; i < bytes.length; i++) {
      c = (c >>> 8) ^ _CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    }
    return (c ^ (-1)) >>> 0;
  }
  /** entry = { name: string, content: string }, STORE (no compression)
   *  v1.2.2 修复：设 General Purpose Bit Flag bit 11 (EFS=1) 标记文件名 UTF-8 编码，
   *  设 version made by = 0x0314 (UNIX, 2.0)，让 WinRAR/Windows Explorer/macOS Archive Utility 都按 UTF-8 解析 */
  const ZIP_EFS_FLAG = 0x0800;          // bit 11 = Language Encoding Flag
  function createZip(entries) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBytes = enc.encode(entry.name);
      const dataBytes  = enc.encode(entry.content);
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      // Local file header (30 + name)
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);             // signature
      lv.setUint16(4,  20, true);                    // version needed (>=20 才能用 EFS)
      lv.setUint16(6,  ZIP_EFS_FLAG, true);          // flags = 0x0800 (bit 11 = UTF-8)
      lv.setUint16(8,   0, true);                    // compression (0 = store)
      lv.setUint16(10,  0, true);                    // mod time
      lv.setUint16(12,  0x21, true);                 // mod date (1980-01-01)
      lv.setUint32(14, crc, true);                   // CRC32
      lv.setUint32(18, size, true);                  // compressed size
      lv.setUint32(22, size, true);                  // uncompressed size
      lv.setUint16(26, nameBytes.length, true);      // file name length
      lv.setUint16(28, 0, true);                     // extra field length
      lh.set(nameBytes, 30);
      localParts.push(lh, dataBytes);

      // Central directory record (46 + name)
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);             // signature
      cv.setUint16(4,  0x0314, true);                // version made by = UNIX (0x03), ver 2.0 (20)
      cv.setUint16(6,  20, true);                    // version needed
      cv.setUint16(8,  ZIP_EFS_FLAG, true);          // flags = 0x0800 (bit 11 = UTF-8)
      cv.setUint16(10,  0, true);                    // compression
      cv.setUint16(12,  0, true);                    // mod time
      cv.setUint16(14,  0x21, true);                 // mod date
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);                  // compressed size
      cv.setUint32(24, size, true);                  // uncompressed size
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);                     // extra
      cv.setUint16(32, 0, true);                     // comment
      cv.setUint16(34, 0, true);                     // disk number
      cv.setUint16(36, 0, true);                     // internal attrs
      cv.setUint32(38, 0, true);                     // external attrs
      cv.setUint32(42, offset, true);                // local header offset
      cd.set(nameBytes, 46);
      centralParts.push(cd);

      offset += lh.length + dataBytes.length;
    }
    const cdStart = offset;
    const cdLen = centralParts.reduce((a, b) => a + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);               // signature
    ev.setUint16(4,  0, true);                       // disk number
    ev.setUint16(6,  0, true);                       // disk where central dir starts
    ev.setUint16(8,  entries.length, true);          // entries on this disk
    ev.setUint16(10, entries.length, true);          // total entries
    ev.setUint32(12, cdLen, true);                   // central dir size
    ev.setUint32(16, cdStart, true);                 // central dir offset
    ev.setUint16(20, 0, true);                       // comment length
    return new Blob([].concat(localParts, centralParts, [eocd]),
                    { type: 'application/zip' });
  }

  /** 文件名消毒：去掉 Windows 非法字符、限长 */
  function sanitizeFilename(s) {
    return String(s || '')
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      .trim() || '(无标题)';
  }

  /** 单会话 JSON 文件（去掉内嵌的 wrapper，符合「一对话一文档」的预期） */
  function buildSessionJson(s) {
    return JSON.stringify(s, null, 2);
  }

  /** 单会话 MD 文件 */
  function buildSessionMd(s) {
    const lines = [];
    lines.push('# ' + (s.title || '(无标题)'));
    lines.push('');
    lines.push('- Session ID: `' + s.id + '`');
    lines.push('- 类型：' + s.title_type + ' · 模型：' + s.model_type +
                ' · 置顶：' + (s.pinned ? '是' : '否'));
    lines.push('- 更新：' + (s.updated_at ? new Date(s.updated_at * 1000).toISOString() : ''));
    lines.push('- 消息数：' + s.message_count);
    if (s.error) lines.push('- ⚠️ 错误：' + s.error);
    lines.push('');
    lines.push('---');
    lines.push('');
    if (s.messages && s.messages.length) {
      for (const m of s.messages) {
        const role = m.role === 'USER' ? '👤 User'
                   : (m.role === 'ASSISTANT' ? '🤖 Assistant' : '⚙️ ' + m.role);
        const ts = m.created_at ? new Date(m.created_at * 1000).toISOString() : '';
        lines.push('### ' + role + ' · ' + ts);
        lines.push('');
        lines.push(extractText(m));
        lines.push('');
      }
    } else {
      lines.push('_（无消息）_');
    }
    return lines.join('\n');
  }

  /** 组装一个完整导出的 ZIP entries */
  function buildZipEntries(data, format) {
    const entries = [];
    entries.push({
      name: 'manifest.json',
      content: JSON.stringify({
        exportedAt: data.meta.exportedAt,
        user: data.meta.user,
        totalSessions: data.meta.totalSessions,
        scope: data.meta.scope || 'all',
        packaging: 'one-doc-per-session',
        format: format,
      }, null, 2),
    });
    for (let i = 0; i < data.sessions.length; i++) {
      const s = data.sessions[i];
      const idx = String(i + 1).padStart(3, '0');
      const safeTitle = sanitizeFilename(s.title);
      const shortId = (s.id || '').slice(0, 8);
      const ext = format === 'json' ? 'json' : 'md';
      const filename = idx + '-' + safeTitle + '--' + shortId + '.' + ext;
      const content = format === 'json' ? buildSessionJson(s) : buildSessionMd(s);
      entries.push({ name: filename, content: content });
    }
    return entries;
  }

  /**
   * format    : 'json' | 'md'
   * scope     : 'all' | 'current'
   * packaging : 'merged' (单文件) | 'zip' (每会话一文件)
   * limit     : 可选——只取前 N 个会话；>0 触发
   */
  async function doExport(format, scope, packaging, limit) {
    scope = scope || 'all';
    packaging = packaging || 'merged';

    // 「当前」模式：先检查 URL
    if (scope === 'current') {
      const sid = getCurrentSessionId();
      if (!sid) {
        setLog('✗ 当前页面不是对话页（URL 应为 /a/chat/s/<id>）');
        return;
      }
      // 关键：把外层 onProgress 转发给 exportCurrent，否则进度永远卡在 '开始导出...'
      return doExportImpl(format, packaging, (onProgress) => exportCurrent(sid, onProgress));
    }
    return doExportImpl(format, packaging, (onProgress) => exportAll(onProgress, limit));
  }

  /**
   * format    : 'json' | 'md'
   * packaging : 'merged' (单文件) | 'zip' (每会话一文件)
   * exporterFn: () => Promise<data>  data = { meta, sessions }
   */
  async function doExportImpl(format, packaging, exporterFn) {
    packaging = packaging || 'merged';
    const jsonBtn    = document.getElementById('ds-exp-exportJson');
    const mdBtn      = document.getElementById('ds-exp-exportMd');
    const jsonCur    = document.getElementById('ds-exp-exportCurJson');
    const mdCur      = document.getElementById('ds-exp-exportCurMd');
    const jsonZipBtn = document.getElementById('ds-exp-exportZipJson');
    const mdZipBtn   = document.getElementById('ds-exp-exportZipMd');
    const testZipJsonBtn = document.getElementById('ds-exp-exportTestZipJson');
    const testZipMdBtn   = document.getElementById('ds-exp-exportTestZipMd');
    [jsonBtn, mdBtn, jsonCur, mdCur, jsonZipBtn, mdZipBtn, testZipJsonBtn, testZipMdBtn]
      .forEach(b => b && (b.disabled = true));
    setProgress(0, '开始导出...');
    setLog('开始导出...');

    try {
      const data = await exporterFn((p) => {
        if (p.stage === 'user') {
          setProgress(5, p.message || '校验登录...');
        } else if (p.stage === 'list') {
          setProgress(7, p.message || '拉取列表...');
        } else if (p.stage === 'list_page') {
          // 分页期间实时显示：单调递增到 9%
          const listFrac = Math.min(p.page / 30, 1);
          const pct = Math.round(5 + listFrac * 4);  // 5% → 9%
          setProgress(pct, p.message || ('已拉 ' + p.total));
        } else if (p.stage === 'fetch') {
          // 单调递增：10% → 99%，无回跳
          const frac = p.total ? (p.current / Math.max(p.total - 1, 1)) : 0;
          const pct = Math.round(10 + frac * 89);    // 10% → 99%
          setProgress(pct, (p.current + 1) + '/' + p.total +
                            ' · ' + ((p.title || '').slice(0, 24)));
        } else if (p.stage === 'done') {
          setProgress(100, '完成 · ' + p.total + ' 个对话');
        }
      });

      // 自动探针：把第一条样本消息的结构 dump 到 console
      // 方便确认 DeepSeek 实际返回的字段（content_blocks / content / 其他）
      probeFirstMsg();

      // 汇总统计
      const totalMsgs = data.sessions.reduce((a, s) => a + (s.message_count || 0), 0);
      const isCurrent = data.meta && data.meta.scope === 'current';
      const isTest    = data.meta && data.meta.limit && data.meta.limit > 0;
      const tag = isCurrent ? 'current' : (isTest ? ('test-' + data.meta.limit) : 'all');

      // 根据 packaging 决定 blob + filename
      let blob, filename, mime, desc;
      if (packaging === 'zip') {
        setProgress(95, '正在打包 ZIP（' + data.sessions.length + ' 个文件）...');
        const entries = buildZipEntries(data, format);
        blob = createZip(entries);
        filename = 'deepseek-' + tag + '-' + dateStr() + '-per-session.zip';
        mime = 'application/zip';
        desc = entries.length + ' 个文件（含 manifest.json）';
      } else {
        if (format === 'json') {
          const text = JSON.stringify(data, null, 2);
          blob = new Blob([text], { type: 'application/json;charset=utf-8' });
          filename = 'deepseek-' + tag + '-' + dateStr() + '.json';
          mime = 'application/json';
        } else {
          const text = toMarkdown(data);
          blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
          filename = 'deepseek-' + tag + '-' + dateStr() + '.md';
          mime = 'text/markdown';
        }
        desc = data.sessions.length + ' 个对话 · ' + totalMsgs + ' 条消息';
      }

      const sizeKB = Math.round(blob.size / 1024);
      setProgress(99, '生成 ' + filename + ' · ' + sizeKB + ' KB · ' + desc);
      setLog('生成 ' + filename + ' · ' + sizeKB + ' KB · ' + desc);

      // 填统计栏
      document.getElementById('ds-exp-stats').style.display = 'grid';
      document.getElementById('ds-exp-statTotal').textContent = data.sessions.length;
      document.getElementById('ds-exp-statMsgs').textContent  = totalMsgs;
      document.getElementById('ds-exp-statSize').textContent  = sizeKB;

      // ---- 复用：blob → 下载 ----
      // 方式 1（推荐）：blob → data: URL → GM_download
      // 解决 GM_download 默认不接受 blob: URL 的 "not_whitelisted" 问题
      function blobToDataUrl(b) {
        return new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload  = () => resolve(r.result);
          r.onerror = () => reject(new Error('FileReader 失败'));
          r.readAsDataURL(b);
        });
      }

      function reEnableButtons() {
        if (jsonBtn)       jsonBtn.disabled = false;
        if (mdBtn)         mdBtn.disabled = false;
        if (jsonCur)       jsonCur.disabled = !getCurrentSessionId();
        if (mdCur)         mdCur.disabled = !getCurrentSessionId();
        if (jsonZipBtn)    jsonZipBtn.disabled = false;
        if (mdZipBtn)      mdZipBtn.disabled = false;
        if (testZipJsonBtn) testZipJsonBtn.disabled = false;
        if (testZipMdBtn)  testZipMdBtn.disabled = false;
      }

      function nativeDownload(b, fn) {
        // 方式 2（兜底）：用原生 <a download>，跳出 GM 沙箱
        try {
          const url = URL.createObjectURL(b);
          const a = document.createElement('a');
          a.href = url;
          a.download = fn;
          a.style.display = 'none';
          (document.body || document.documentElement).appendChild(a);
          a.click();
          setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
          }, 200);
          setLog('✓ 已触发下载（原生 <a download>）');
        } catch (e) {
          setLog('✗ 原生下载也失败: ' + e.message);
        }
        reEnableButtons();
      }

      let dataUrl;
      try {
        dataUrl = await blobToDataUrl(blob);
      } catch (e) {
        setLog('FileReader 失败，回退到原生下载: ' + e.message);
        nativeDownload(blob, filename);
        return;
      }

      GM_download({
        url: dataUrl,
        name: filename,
        saveAs: true,
        onload: () => {
          setLog('✓ 下载完成（GM_download via data URL）');
          reEnableButtons();
        },
        onerror: (e) => {
          setLog('✗ GM_download 失败: ' + (e && e.error ? e.error : JSON.stringify(e)) +
                 '，回退到原生 <a download>');
          nativeDownload(blob, filename);
        },
        ontimeout: () => {
          setLog('✗ GM_download 超时，回退到原生 <a download>');
          nativeDownload(blob, filename);
        },
      });
    } catch (e) {
      setProgress(0, '✗ ' + (e.message || e));
      setLog('导出失败: ' + (e.message || e));
      // 把所有按钮都启用（包括测试 ZIP），方便重新尝试
      [
        'ds-exp-exportJson', 'ds-exp-exportMd',
        'ds-exp-exportZipJson', 'ds-exp-exportZipMd',
        'ds-exp-exportTestZipJson', 'ds-exp-exportTestZipMd',
      ].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
      const mdCurR = document.getElementById('ds-exp-exportCurMd');
      const jsonCurR = document.getElementById('ds-exp-exportCurJson');
      if (mdCurR)   mdCurR.disabled = !getCurrentSessionId();
      if (jsonCurR) jsonCurR.disabled = !getCurrentSessionId();
    }
  }
})();

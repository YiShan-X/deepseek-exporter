<div align="center">

# DeepSeek 对话历史导出

**一个零外联、零持久化的 Tampermonkey 脚本**
把 `chat.deepseek.com` 上**你自己账号**的对话历史导出为 **JSON / Markdown / ZIP**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-required-orange.svg)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Firefox-blue.svg)]()
[![Local Only](https://img.shields.io/badge/Data-Local%20Only-success.svg)]()

[English](./README.en.md) · [快速开始](#-快速开始)

</div>

---

## 📑 目录

- [核心特性](#-核心特性)
- [快速开始](#-快速开始)
- [使用说明](#-使用说明)
- [工作原理](#-工作原理)
- [安全与合规](#-安全与合规)
- [已知限制](#-已知限制)
- [路线图](#-路线图)
- [License](#-license)

---

## ✨ 核心特性

| 维度 | 说明 |
|------|------|
| 🔒 **零外联** | 所有请求走页面原生 `fetch`（自动带 Cookie），不引入任何第三方服务 |
| 💾 **零持久化** | Bearer Token 只存在内存里，关 tab 即失 |
| 🚫 **不绕 PoW** | 只调用只读接口（`/users/current` · `/chat_session/fetch_page` · `/chat/history_messages`） |
| 🐢 **礼貌限速** | 每 5 个会话停 800ms，防止触发风控 |
| 📊 **进度实时** | 右下角浮窗 + 模态面板，单调递增进度条 |
| 📦 **多格式导出** | JSON 完整结构 / Markdown 易读排版（保留思考过程、工具调用）/ 每会话独立 ZIP 打包 |
| 🔄 **全量拉取** | 用 keyset cursor 翻到底，20000 会话硬上限 |
| ⚡ **单会话秒出** | 从 URL 拿当前会话 ID，跳过列表查询，适合测试 |
| 🧪 **测试 ZIP** | 前 5 个会话打包，几秒出结果，验证格式无误再跑全量 |
| 🧭 **路由自适应** | 监听 SPA 路由变化，按钮自动启用 / 禁用 |

---

## 🚀 快速开始

### 第 1 步：安装 Tampermonkey

浏览器扩展商店搜索 **Tampermonkey**（[Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) · [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) · [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)）。

### 第 2 步：安装脚本

打开 [`deepseek-exporter.user.js`](./deepseek-exporter.user.js) → 全选复制 → Tampermonkey 控制面板「实用工具」→「从剪贴板导入」。

或直接新建脚本粘贴保存。

### 第 3 步：启动导出

1. 打开 <https://chat.deepseek.com/>
2. 在左栏点开 **1\~2 个对话**（让浏览器发出带 `Authorization` 头的 fetch，脚本会**被动**捕获 Token）
3. 点击右下角 📥 浮窗 → 选你要的格式 → 等待下载

> 💡 **首次推荐流程**：打开任一对话 → 点 `⚡ 当前 Markdown` → 几秒后下载 → 打开看字段是否识别正确 → 验证 OK 再跑全量。

---

## 📖 使用说明

| 按钮 | 范围 | 格式 | 用途 |
|------|------|------|------|
| **全量合并 1 个 JSON** | 全量 | JSON | 把所有会话合并到单文件，结构最完整 |
| **全量合并 1 个 Markdown** | 全量 | Markdown | 所有会话合并到单文件，人类可读 |
| **📦 全量逐个 ZIP (JSON)** | 全量 | ZIP | 每会话独立 `.json` + `manifest.json` 打包 |
| **📦 全量逐个 ZIP (Markdown)** | 全量 | ZIP | 每会话独立 `.md` + `manifest.json` 打包 |
| **⚡ 当前 1 个 JSON** | 当前会话 | JSON | 跳过列表查询，秒出结果 |
| **⚡ 当前 1 个 Markdown** | 当前会话 | Markdown | 同上，Markdown 格式 |
| **🧪 测试 ZIP (前 5 个 JSON)** | 前 5 | ZIP | 几秒出结果，验证 ZIP 格式 |
| **🧪 测试 ZIP (前 5 个 MD)** | 前 5 | ZIP | 同上，Markdown 格式 |

### ZIP 文件结构

解压 `deepseek-all-YYYYMMDD-HHMM-per-session.zip` 后：

```
deepseek-all-20260707-1300-per-session.zip
├── manifest.json                          ← 导出元信息（用户、时间、范围）
├── 001-标题1--fa5d16f5.md
├── 002-标题2--35313c17.md
└── ...
```

> **文件名规则**：`编号-标题消毒后--会话ID前8位.{json|md}`

---

## 🔍 工作原理

```
┌────────────┐   ① hook fetch      ┌──────────────────┐
│  页面原生  │ ◀────────────────── │  Tampermonkey    │
│   fetch    │ ── 捕获 Bearer ────▶│     脚本         │
└─────┬──────┘                     └────────┬─────────┘
      │                                     │
      │ ② 用捕获的 Token 调只读 API          │
      ▼                                     │
┌──────────────────────────────────┐        │
│  chat.deepseek.com/api/v0/*      │        │
│   - /users/current               │        │
│   - /chat_session/fetch_page     │        │
│   - /chat/history_messages       │        │
└────────┬─────────────────────────┘        │
         │                                  │
         │ ③ 返回 JSON                      │
         ▼                                  ▼
   ┌──────────────────┐         ┌──────────────────────┐
   │ 内存组装数据     │ ──────▶ │ GM_download / <a>    │
   │  生成 ZIP / MD   │         │ 触发浏览器下载       │
   └──────────────────┘         └──────────────────────┘
```

### 关键技术点

- **Token 捕获**：`unsafeWindow.fetch` 钩子 + `XMLHttpRequest.setRequestHeader` 兜底，从 `Authorization: Bearer ...` 被动取出 Token
- **会话分页**：用上一页最后一项 `(pinned, updated_at, id)` 作 keyset cursor 构造下一页请求，5 个独立终止条件
- **ZIP 打包**：内联 **STORE-only zip 写入器 + CRC32**，零依赖，不引入 JSZip；UTF-8 文件名标记位（修复乱码）
- **下载兼容**：Blob → `data:` URL → `GM_download`，失败回退到原生 `<a download>`
- **超时控制**：每次 API 调用 15s AbortController 超时 + console 探针

---

## 🛡️ 安全与合规

> ⚠️ **本工具仅用于备份你自己账号的数据**。任何滥用——批量抓取他人账号、绕过 DeepSeek 鉴权、向第三方分发抓取的数据——都违反 DeepSeek ToS 与《数据安全法》第 21/27 条，**与作者无关**。

### 数据流承诺

- ✅ Token 仅在内存存在，**永远不会**写入 `localStorage` / IndexedDB / Cookie
- ✅ 脚本仅在 `chat.deepseek.com` 上激活（`@match` 强制）
- ✅ 不发起任何跨域请求，**所有外发流量都是发回 `chat.deepseek.com` 的只读接口**
- ✅ 开源 MIT，代码可审计

### 已知 schema 不稳

> ⚠️ DeepSeek 的 `/api/v0/*` 接口目前没有公开稳定性承诺。如果 schema 改了，脚本会失效。提 issue 时附上控制台的 `[DS-Exporter] → / ✓ / ✗` 日志，方便定位。

---

## 🧩 已知限制

- **20000 会话数硬上限**
- **上传文件只导出 `file_info`**，原始文件二进制需要单独走 `/file/fetch_uploaded_files`
- **`history_messages` 全量回带**（cacheControl: REPLACE），不支持断点续传；网络中断需重新开始
- **限速影响大账号**：单次导出 5 个会话后停 800ms，>5000 会话会跑数分钟
- **ZIP 是 STORE-only**（不压缩），体积比 7z / zip 压缩模式大约 2-3 倍；如需压缩可用 WinRAR / 7-Zip 二次处理

---

## 🗺️ 路线图

- [ ] 选择性导出（按时间范围 / 关键词筛选会话）
- [ ] HTML 导出（带样式 + 头像）
- [ ] 增量同步（断点续传 + 增量）
- [ ] 国际化（UI 多语言）

---

## 📄 License

[MIT](./LICENSE) © 2026 YiShan-X

---

<div align="center">

**[⬆ 回到顶部](#deepseek-对话历史导出)**

🌐 English version: [README.en.md](./README.en.md)

</div>

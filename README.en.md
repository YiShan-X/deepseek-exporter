<div align="center">

# DeepSeek Chat History Exporter

**A zero-egress, zero-persistence Tampermonkey userscript**
Export **your own** DeepSeek (`chat.deepseek.com`) conversation history as **JSON / Markdown / ZIP**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-required-orange.svg)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Firefox-blue.svg)]()
[![Local Only](https://img.shields.io/badge/Data-Local%20Only-success.svg)]()

[中文](./README.md) · [Quick Start](#-quick-start)

</div>

---

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Usage](#-usage)
- [How It Works](#-how-it-works)
- [Security & Compliance](#-security--compliance)
- [Known Limits](#-known-limits)
- [Roadmap](#-roadmap)
- [License](#-license)

---

## ✨ Features

| Concern | Detail |
|---------|--------|
| 🔒 **Zero external calls** | All requests use the page's native `fetch` (auto Cookie); no third-party services |
| 💾 **Zero persistence** | Bearer token lives only in memory; gone when the tab closes |
| 🚫 **No PoW bypass** | Calls only read-only endpoints (`/users/current`, `/chat_session/fetch_page`, `/chat/history_messages`) |
| 🐢 **Polite throttling** | 800ms pause every 5 sessions to avoid rate limits |
| 📊 **Live progress** | Floating action button + modal panel, monotonic progress bar |
| 📦 **Multi-format export** | JSON (full structure) / Markdown (human-readable, preserves thinking + tool calls) / per-session ZIP |
| 🔄 **Full-history pull** | Keyset cursor pagination up to 20,000 sessions |
| ⚡ **One-shot current session** | Reads session ID from URL, skips list query — great for testing |
| 🧪 **Test ZIP** | First 5 sessions only, result in seconds, validates format before full run |
| 🧭 **SPA-aware** | Watches route changes, auto enables/disables buttons |

---

## 🚀 Quick Start

### Step 1: Install Tampermonkey

Search **Tampermonkey** in your browser's extension store ([Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) · [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) · [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)).

### Step 2: Install the script

Open [`deepseek-exporter.user.js`](./deepseek-exporter.user.js) → select all & copy → in Tampermonkey's dashboard "Utilities" → "Import from clipboard".

Or create a new script and paste.

### Step 3: Export

1. Open <https://chat.deepseek.com/>
2. Click **1–2 chats** in the left sidebar (this triggers a `fetch` with `Authorization` header — the script **passively** captures the token)
3. Click the 📥 floating button (bottom-right) → pick a format → wait for download

> 💡 **First-time test flow**: open any chat → click `⚡ Current Markdown` → download in a few seconds → verify fields are recognized → only then run full export.

---

## 📖 Usage

| Button | Scope | Format | Purpose |
|--------|-------|--------|---------|
| **All → 1 JSON** | All | JSON | Merge all sessions into one file, full structure |
| **All → 1 Markdown** | All | Markdown | All sessions in one human-readable file |
| **📦 All → per-session ZIP (JSON)** | All | ZIP | One `.json` per session + `manifest.json` |
| **📦 All → per-session ZIP (Markdown)** | All | ZIP | One `.md` per session + `manifest.json` |
| **⚡ Current → 1 JSON** | Current | JSON | Skip list query, instant result |
| **⚡ Current → 1 Markdown** | Current | Markdown | Same, Markdown format |
| **🧪 Test ZIP (first 5 JSON)** | First 5 | ZIP | Seconds, validates ZIP format |
| **🧪 Test ZIP (first 5 MD)** | First 5 | ZIP | Same, Markdown format |

### ZIP layout

After unzipping `deepseek-all-YYYYMMDD-HHMM-per-session.zip`:

```
deepseek-all-20260707-1300-per-session.zip
├── manifest.json                          ← export metadata (user, time, scope)
├── 001-title-1--fa5d16f5.md
├── 002-title-2--35313c17.md
└── ...
```

> **Filename rule**: `NNN-sanitized-title--first-8-of-session-id.{json|md}`

---

## 🔍 How It Works

```
┌────────────┐   ① hook fetch      ┌──────────────────┐
│  Page's    │ ◀────────────────── │  Tampermonkey    │
│  fetch     │ ── capture Bearer ─▶│     script       │
└─────┬──────┘                     └────────┬─────────┘
      │                                     │
      │ ② Call read-only API with token     │
      ▼                                     │
┌──────────────────────────────────┐        │
│  chat.deepseek.com/api/v0/*      │        │
│   - /users/current               │        │
│   - /chat_session/fetch_page     │        │
│   - /chat/history_messages       │        │
└────────┬─────────────────────────┘        │
         │                                  │
         │ ③ JSON response                  │
         ▼                                  ▼
   ┌──────────────────┐         ┌──────────────────────┐
   │ Build in memory  │ ──────▶ │ GM_download / <a>    │
   │ ZIP / MD output  │         │ Browser download     │
   └──────────────────┘         └──────────────────────┘
```

### Key techniques

- **Token capture**: hook `unsafeWindow.fetch` + `XMLHttpRequest.setRequestHeader` fallback, passively reads `Authorization: Bearer ...`
- **Session pagination**: keyset cursor using `(pinned, updated_at, id)` from the last item, 5 independent termination conditions
- **ZIP packing**: inline **STORE-only zip writer + CRC32**, zero deps, no JSZip; UTF-8 filename flag (fixed mojibake)
- **Download compatibility**: Blob → `data:` URL → `GM_download`, falls back to native `<a download>`
- **Timeout control**: 15s AbortController per API call + console probe

---

## 🛡️ Security & Compliance

> ⚠️ **This tool is for backing up your own account data only.** Any misuse — bulk-scraping other accounts, bypassing DeepSeek auth, distributing scraped data to third parties — violates DeepSeek's ToS and applicable data protection laws. The author bears no responsibility.

### Data-flow guarantees

- ✅ Token exists only in memory; **never** written to `localStorage` / IndexedDB / Cookies
- ✅ Script only activates on `chat.deepseek.com` (enforced by `@match`)
- ✅ No cross-origin requests; **all outbound traffic goes only to read-only endpoints on `chat.deepseek.com`**
- ✅ Open-source MIT, code is auditable

### Known schema instability

> ⚠️ DeepSeek's `/api/v0/*` endpoints have no public stability commitment. If the schema changes, the script will break. When filing an issue, include the console's `[DS-Exporter] → / ✓ / ✗` logs for fast diagnosis.

---

## 🧩 Known Limits

- **20,000 session hard cap**
- **Uploaded files export `file_info` only**; raw file binaries need a separate `/file/fetch_uploaded_files` call
- **`history_messages` is full-payload** (cacheControl: REPLACE); no resume on network interruption
- **Throttling impacts large accounts**: 800ms pause every 5 sessions → >5,000 sessions takes several minutes
- **ZIP is STORE-only** (no compression), 2–3× the size of compressed archives; re-compress with WinRAR / 7-Zip if needed

---

## 🗺️ Roadmap

- [ ] Selective export (date range / keyword filter on sessions)
- [ ] HTML export (styled + avatars)
- [ ] Incremental sync (resume + delta)
- [ ] i18n (UI multi-language)

---

## 📄 License

[MIT](./LICENSE) © 2026 YiShan-X

---

<div align="center">

**[⬆ Back to top](#deepseek-chat-history-exporter)**

🌐 中文版：[README.md](./README.md)

</div>

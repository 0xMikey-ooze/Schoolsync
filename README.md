# SchoolSync 🔄

**Securely sync student data from PowerSchool into Capsule — without IT department approval.**

Chrome extension that watches PowerSchool pages as you browse and automatically extracts student roster, gradebook, and attendance data into your Capsule.

## Features

- **Zero-config sync** — Browse PowerSchool normally, SchoolSync detects and captures data
- **One-click bulk export** — Intercepts `/admin/students/export.html` CSV downloads
- **Smart diffing** — Only syncs changed records (SHA-256 hash comparison)
- **Encrypted at rest** — API tokens encrypted with AES-256-GCM (PBKDF2 key derivation)
- **No PII stored locally** — Only hashes stored for change detection
- **Auto-sync** — Schedule syncs every 6/12/24 hours or weekly
- **Dark theme UI** — Clean, minimal popup interface

## Supported Pages

| PowerSchool Page | Data Extracted |
|---|---|
| Class Roster | Student names, IDs, grade levels, homeroom |
| Quick Export (admin) | Full student records from CSV |
| Gradebook | Assignments, scores, categories |
| Attendance | Daily/period attendance status |

## Security

- **AES-256-GCM** encryption for stored tokens (100K PBKDF2 iterations)
- **No PII in chrome.storage** — only SHA-256 hashes for diffing
- **Token in memory only** — encrypted copy on disk, decrypted per-session
- **HTTPS only** — all Capsule API calls over TLS
- **Minimal permissions** — only activates on `*.powerschool.com`
- **No analytics, no telemetry, no tracking**

## Install (Development)

1. Clone this repo
2. Open `chrome://extensions`
3. Enable "Developer mode"
4. Click "Load unpacked" → select this directory
5. Navigate to any PowerSchool page

## Setup

1. Click the SchoolSync icon in Chrome toolbar
2. Enter your Capsule API endpoint and token
3. Create an encryption passphrase (stored nowhere — you must remember it)
4. Navigate to PowerSchool → data syncs automatically

## Architecture

```
content/detector.js     — Detects PowerSchool page type
content/parsers/        — Page-specific DOM parsers
  ├── roster.js         — Class roster tables
  ├── export-csv.js     — CSV file parsing (Quick Export)
  ├── gradebook.js      — Grade grids
  └── attendance.js     — Attendance records
background/             — Service worker (sync orchestration)
lib/                    — Crypto, storage, Capsule API client
popup/                  — Settings + sync dashboard UI
```

## How It Works

1. Content script detects which PowerSchool page you're on
2. Page-specific parser extracts structured data from the DOM
3. Records are hashed (SHA-256) and compared to stored hashes
4. Only changed/new records are sent to Capsule API in batches of 50
5. Hashes updated locally for next diff cycle

## Privacy

- Extension ONLY activates on PowerSchool domains
- Data goes directly to YOUR Capsule instance — no intermediary servers
- All tokens encrypted with your passphrase before touching disk
- Sync log shows exactly what was captured and when
- One click to disconnect and clear all local data

## License

MIT — Peopleppl LLC

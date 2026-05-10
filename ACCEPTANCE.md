# Schoolsync × sprites.dev OAuth + LLM Assignment Intelligence Acceptance

## Scheduler Timing & API Latency Verification

Verdict: **INCONCLUSIVE**

Claim under test:

- The background assignment poller can be started locally, emits observable logs over a 30-minute window, and fires within +/- 30 seconds of each 15-minute interval for at least two firings.
- `POST /api/refresh`, with a warm LLM and realistic assignment payload, has p50 latency under 10 seconds across at least three runs.

Evidence captured in this worktree:

```text
$ rg --files -g '!node_modules'
manifest.json
README.md
icons/icon-128.png
icons/README.md
icons/icon-48.png
icons/icon-16.png
src/lib/storage.js
src/lib/crypto.js
src/lib/hasher.js
src/lib/capsule-client.js
src/popup/popup.css
src/popup/popup.html
src/popup/popup.js
src/content/badge.css
src/content/crawler.js
src/content/detector.js
src/background/service-worker.js
src/content/parsers/classlink.js
src/content/parsers/infinite-campus.js
src/content/parsers/skyward.js
src/content/parsers/gradebook.js
src/content/parsers/clever.js
src/content/parsers/roster.js
src/content/parsers/canvas.js
src/content/parsers/genesis.js
src/content/parsers/aeries.js
src/content/parsers/schoology.js
src/content/parsers/export-csv.js
src/content/parsers/attendance.js
```

```text
$ find . -maxdepth 3 -type f \( -name 'package.json' -o -name 'vite.config.*' -o -name 'next.config.*' -o -name 'server.js' -o -name 'app.js' -o -name 'ACCEPTANCE.md' \) -print
<no matches before this file was added>
```

```text
$ .sonicswarm/start-app.sh 3000
zsh:1: no such file or directory: .sonicswarm/start-app.sh
```

```text
$ rg -n "chrome\.alarms|onAlarm|setInterval|periodInMinutes|api/refresh|/api/refresh|fetch\(" src manifest.json README.md
src/popup/popup.js:345:  await chrome.alarms.clear('schoolsync-auto');
src/popup/popup.js:347:    chrome.alarms.create('schoolsync-auto', { periodInMinutes: hours * 60 });
src/popup/popup.js:355:    await chrome.alarms.clear('schoolsync-auto');
src/popup/popup.js:356:    chrome.alarms.create('schoolsync-auto', { periodInMinutes: hours * 60 });
src/popup/popup.js:365:  await chrome.alarms.clear('schoolsync-auto');
src/background/service-worker.js:319:chrome.alarms.onAlarm.addListener(async (alarm) => {
src/background/service-worker.js:337:  await chrome.alarms.clear(ALARM_NAME);
src/background/service-worker.js:339:    chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalHours * 60 });
src/lib/capsule-client.js:46:      const response = await fetch(`${endpoint}/api/v1/sync/students`, {
src/lib/capsule-client.js:88:    const response = await fetch(`${endpoint}/api/v1/health`, {
src/background/service-worker.js:166:    const response = await fetch(url);
src/background/service-worker.js:211:      const resp = await fetch(`${config.capsule_endpoint}/api/v1/sync/students`, {
```

Scheduler finding:

- The only scheduler found is the Chrome extension alarm `schoolsync-auto`.
- The popup and exported helper configure this alarm with `periodInMinutes: hours * 60`, based on user-selected hour intervals, not a fixed 15-minute assignment poller.
- The alarm listener in `src/background/service-worker.js` does not poll sprites.dev or assignment data. It queries PowerSchool tabs and sets a badge because it cannot auto-sync without a passphrase.
- There is no local server process or log stream to observe for 30 minutes, so the required two 15-minute firings cannot be measured in this worktree.

API latency finding:

- No `POST /api/refresh` endpoint exists in the repository.
- No Node.js server runtime, `package.json`, Next/Vite config, tRPC router, LLM pipeline, or realistic assignment fixture exists in this checkout.
- Because the endpoint cannot be started or requested, p50 latency cannot be measured locally.

Risk and scope notes:

- Forbidden paths avoided: recovery, rollback, state repair, auth token handling, persistence/schema changes, and runtime state mutation.
- This verification changed only this acceptance evidence document. It did not alter scheduler code, auth code, storage, migrations, or API behavior.

Next action:

- Restore or merge the server/runtime branch that owns the sprites.dev poller, `POST /api/refresh`, LLM assignment pipeline, and realistic fixture, then rerun this verification from a worktree that contains those artifacts.

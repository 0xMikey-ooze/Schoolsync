/**
 * SchoolSync Popup — UI controller for the extension popup.
 */

const $ = (sel) => document.querySelector(sel);

// Views
const setupView = $('#setup-view');
const mainView = $('#main-view');

// Setup elements
const setupForm = $('#setup-form');
const endpointInput = $('#endpoint');
const tokenInput = $('#token');
const passphraseInput = $('#passphrase');
const setupError = $('#setup-error');
const setupSuccess = $('#setup-success');
const connectBtn = $('#connect-btn');

// Main elements
const statusDot = $('#status-dot');
const statusText = $('#status-text');
const lastSyncEl = $('#last-sync');
const pageInfo = $('#page-info');
const syncBtn = $('#sync-btn');
const syncLabel = $('#sync-label');
const syncProgress = $('#sync-progress');
const progressBar = $('#progress-bar');
const syncResult = $('#sync-result');
const syncPassphrase = $('#sync-passphrase');
const autoSyncToggle = $('#auto-sync');
const scheduleOptions = $('#schedule-options');
const intervalSelect = $('#interval');
const syncLogEl = $('#sync-log');
const disconnectBtn = $('#disconnect-btn');

// --- Init ---

async function init() {
  const config = await chrome.storage.local.get(['capsule_endpoint', 'encrypted_token']);

  if (config.capsule_endpoint && config.encrypted_token) {
    showMainView();
  } else {
    showSetupView();
  }
}

function showSetupView() {
  setupView.classList.remove('hidden');
  mainView.classList.add('hidden');
}

async function showMainView() {
  setupView.classList.add('hidden');
  mainView.classList.remove('hidden');
  await refreshStatus();
  await refreshSyncLog();
  await detectCurrentPage();
}

// --- Setup ---

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setupError.classList.add('hidden');
  setupSuccess.classList.add('hidden');
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';

  const endpoint = endpointInput.value.trim().replace(/\/+$/, '');
  const token = tokenInput.value.trim();
  const passphrase = passphraseInput.value;

  if (!passphrase || passphrase.length < 4) {
    showError(setupError, 'Passphrase must be at least 4 characters');
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    return;
  }

  try {
    // Test connection
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(`${endpoint}/api/v1/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    // Encrypt token
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));

    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
    const encrypted = btoa(String.fromCharCode(...combined));

    await chrome.storage.local.set({
      capsule_endpoint: endpoint,
      encrypted_token: encrypted,
    });

    if (!resp || !resp.ok) {
      setupSuccess.textContent = 'Saved! (Could not verify endpoint — will retry on sync)';
    } else {
      setupSuccess.textContent = 'Connected successfully!';
    }
    setupSuccess.classList.remove('hidden');

    setTimeout(() => showMainView(), 1000);
  } catch (err) {
    showError(setupError, `Connection failed: ${err.message}`);
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
  }
});

// --- Main Dashboard ---

async function refreshStatus() {
  const config = await chrome.storage.local.get(['capsule_endpoint', 'last_sync', 'sync_schedule']);

  statusDot.className = 'status-dot connected';
  statusText.textContent = `Connected to ${new URL(config.capsule_endpoint).hostname}`;

  if (config.last_sync) {
    const ago = timeAgo(config.last_sync.timestamp);
    lastSyncEl.textContent = `Last sync: ${ago} — ${config.last_sync.studentCount} students (${config.last_sync.status})`;
  } else {
    lastSyncEl.textContent = 'No syncs yet';
  }

  // Auto-sync
  const schedule = config.sync_schedule || { enabled: false, intervalHours: 24 };
  autoSyncToggle.checked = schedule.enabled;
  intervalSelect.value = String(schedule.intervalHours);
  if (schedule.enabled) scheduleOptions.classList.remove('hidden');
}

async function detectCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !tab.url.includes('powerschool.com')) {
      pageInfo.textContent = 'Navigate to a PowerSchool page to sync';
      syncBtn.classList.add('hidden');
      return;
    }

    // Ask content script what it detected
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'PARSE_PAGE' }).catch(() => null);

    if (result && result.count > 0) {
      const sis = result.sisType ? ` (${result.sisType})` : '';
      const labels = {
        roster: `📋 Roster: ${result.count} students${sis}`,
        export: `📥 Export: ${result.count} students${sis}`,
        gradebook: `📊 Gradebook: ${result.count} students${sis}`,
        attendance: `✅ Attendance: ${result.count} records${sis}`,
      };
      pageInfo.textContent = labels[result.pageType] || `${result.count} records detected${sis}`;
      syncBtn.classList.remove('hidden');
      syncBtn.disabled = false;
      syncBtn.dataset.tabId = tab.id;

      // Check for deep crawl links
      const linkResult = await chrome.tabs.sendMessage(tab.id, { type: 'COUNT_LINKS' }).catch(() => null);
      if (linkResult && linkResult.count > 0) {
        deepBtn.classList.remove('hidden');
        deepBtn.disabled = false;
        deepBtn.dataset.tabId = tab.id;
        deepHint.classList.remove('hidden');
        deepHint.textContent = `Deep crawl: ${linkResult.count} student profiles available — pulls contacts, schedule, demographics, and more.`;
      }
    } else {
      pageInfo.textContent = 'SIS page detected — no parseable data found';
      syncBtn.classList.add('hidden');
      deepBtn.classList.add('hidden');
    }
  } catch {
    pageInfo.textContent = 'Navigate to a PowerSchool page to sync';
    syncBtn.classList.add('hidden');
  }
}

const deepBtn = $('#deep-btn');
const deepLabel = $('#deep-label');
const deepHint = $('#deep-hint');
const crawlStatus = $('#crawl-status');

// Listen for crawl progress from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CRAWL_PROGRESS') {
    crawlStatus.textContent = `Crawling ${msg.current}/${msg.total}: ${msg.student}`;
    crawlStatus.classList.remove('hidden');
    progressBar.style.width = `${(msg.current / msg.total) * 100}%`;
  }
});

// Deep crawl button
deepBtn.addEventListener('click', async () => {
  const tabId = parseInt(syncBtn.dataset.tabId);
  const passphrase = syncPassphrase.value;

  if (!passphrase) {
    syncPassphrase.focus();
    syncPassphrase.style.borderColor = '#ef4444';
    setTimeout(() => { syncPassphrase.style.borderColor = ''; }, 2000);
    return;
  }

  deepBtn.disabled = true;
  syncBtn.disabled = true;
  deepLabel.textContent = 'Crawling...';
  statusDot.className = 'status-dot syncing';
  syncProgress.classList.remove('hidden');
  syncResult.classList.add('hidden');
  crawlStatus.classList.remove('hidden');
  crawlStatus.textContent = 'Starting deep crawl...';

  try {
    // Ask content script to deep crawl
    const result = await chrome.tabs.sendMessage(tabId, { type: 'DEEP_CRAWL' });

    progressBar.style.width = '100%';

    if (result && result.count > 0) {
      // Sync the deep results to Capsule
      const syncRes = await chrome.runtime.sendMessage({
        type: 'TRIGGER_DEEP_SYNC',
        students: result.students,
        passphrase,
      });

      crawlStatus.classList.add('hidden');
      syncResult.textContent = `✅ Deep crawl: ${result.count} students with full profiles synced`;
      syncResult.className = 'success';
      statusDot.className = 'status-dot connected';
    } else {
      crawlStatus.classList.add('hidden');
      syncResult.textContent = '❌ No student profile links found on this page';
      syncResult.className = 'error';
      statusDot.className = 'status-dot error';
    }
    syncResult.classList.remove('hidden');
  } catch (err) {
    crawlStatus.classList.add('hidden');
    syncResult.textContent = `❌ ${err.message}`;
    syncResult.className = 'error';
    syncResult.classList.remove('hidden');
    statusDot.className = 'status-dot error';
  } finally {
    deepBtn.disabled = false;
    syncBtn.disabled = false;
    deepLabel.textContent = '🔍 Deep Crawl';
    setTimeout(() => {
      syncProgress.classList.add('hidden');
      progressBar.style.width = '0%';
    }, 2000);
    await refreshStatus();
    await refreshSyncLog();
  }
});

// Sync button
syncBtn.addEventListener('click', async () => {
  const tabId = parseInt(syncBtn.dataset.tabId);
  const passphrase = syncPassphrase.value;

  if (!passphrase) {
    syncPassphrase.focus();
    syncPassphrase.style.borderColor = '#ef4444';
    setTimeout(() => { syncPassphrase.style.borderColor = ''; }, 2000);
    return;
  }

  syncBtn.disabled = true;
  syncLabel.textContent = 'Syncing...';
  statusDot.className = 'status-dot syncing';
  syncProgress.classList.remove('hidden');
  syncResult.classList.add('hidden');

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'TRIGGER_SYNC',
      tabId,
      passphrase,
    });

    progressBar.style.width = '100%';

    if (result.success) {
      syncResult.textContent = `✅ Synced ${result.count} students${result.total ? ` (${result.total} total, ${result.total - result.count} unchanged)` : ''}`;
      syncResult.className = 'success';
      statusDot.className = 'status-dot connected';
    } else {
      syncResult.textContent = `❌ ${result.error || 'Sync failed'}`;
      syncResult.className = 'error';
      statusDot.className = 'status-dot error';
    }
    syncResult.classList.remove('hidden');
  } catch (err) {
    syncResult.textContent = `❌ ${err.message}`;
    syncResult.className = 'error';
    syncResult.classList.remove('hidden');
    statusDot.className = 'status-dot error';
  } finally {
    syncBtn.disabled = false;
    syncLabel.textContent = 'Sync Now';
    setTimeout(() => {
      syncProgress.classList.add('hidden');
      progressBar.style.width = '0%';
    }, 2000);
    await refreshStatus();
    await refreshSyncLog();
  }
});

// Auto-sync toggle
autoSyncToggle.addEventListener('change', async () => {
  const enabled = autoSyncToggle.checked;
  const hours = parseInt(intervalSelect.value);

  if (enabled) {
    scheduleOptions.classList.remove('hidden');
  } else {
    scheduleOptions.classList.add('hidden');
  }

  await chrome.alarms.clear('schoolsync-auto');
  if (enabled) {
    chrome.alarms.create('schoolsync-auto', { periodInMinutes: hours * 60 });
  }
  await chrome.storage.local.set({ sync_schedule: { enabled, intervalHours: hours } });
});

intervalSelect.addEventListener('change', async () => {
  if (autoSyncToggle.checked) {
    const hours = parseInt(intervalSelect.value);
    await chrome.alarms.clear('schoolsync-auto');
    chrome.alarms.create('schoolsync-auto', { periodInMinutes: hours * 60 });
    await chrome.storage.local.set({ sync_schedule: { enabled: true, intervalHours: hours } });
  }
});

// Disconnect
disconnectBtn.addEventListener('click', async () => {
  if (!confirm('Disconnect from Capsule? Your synced data will remain in Capsule.')) return;
  await chrome.storage.local.clear();
  await chrome.alarms.clear('schoolsync-auto');
  showSetupView();
});

// Sync log
async function refreshSyncLog() {
  const result = await chrome.storage.local.get('sync_log');
  const log = result.sync_log || [];

  if (log.length === 0) {
    syncLogEl.innerHTML = '<div class="log-empty">No syncs yet</div>';
    return;
  }

  syncLogEl.innerHTML = log.slice(0, 10).map(entry => `
    <div class="log-entry ${entry.status === 'error' ? 'error' : ''}">
      <span class="time">${timeAgo(entry.timestamp)}</span> —
      <span class="count">${entry.studentCount} students</span>
      ${entry.status !== 'success' ? `<span class="error">(${entry.status})</span>` : ''}
    </div>
  `).join('');
}

// Helpers
function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

// --- SchoolsyncPanel (PRD Lane 4 — UI: Assignment Dashboard) ---
//
// The PRD describes a Next.js + tRPC + react-query dashboard panel; in this
// MV3 popup we run the equivalent logic against chrome.runtime messages. The
// data layer lives in src/lib/sprites-panel-data.js and is reachable via the
// SPRITES_GET_PANEL_DATA / SPRITES_REFRESH_NOW message contracts.
//
// The panel renders four explicit states (no silent blanks):
//   1. unauthenticated  → "Connect via sprites.dev" CTA
//   2. loading          → skeleton placeholder cards
//   3. error            → inline error + Retry button
//   4. ok / empty       → subject-grouped cards + overdue + summary

import { formatLastSynced } from '../lib/sprites-panel-data.js';

const schoolsyncRefreshBtn = $('#schoolsync-refresh-btn');
const schoolsyncRefreshLabel = $('#schoolsync-refresh-label');
const schoolsyncLastSynced = $('#schoolsync-last-synced');
const schoolsyncAuthBanner = $('#schoolsync-auth-banner');
const schoolsyncConnectBtn = $('#schoolsync-connect-btn');
const schoolsyncLoading = $('#schoolsync-loading');
const schoolsyncError = $('#schoolsync-error');
const schoolsyncErrorMessage = $('#schoolsync-error-message');
const schoolsyncRetryBtn = $('#schoolsync-retry-btn');
const schoolsyncEmpty = $('#schoolsync-empty');
const schoolsyncOverdueSection = $('#schoolsync-overdue-section');
const schoolsyncOverdueList = $('#schoolsync-overdue-list');
const schoolsyncCategorized = $('#schoolsync-categorized');
const schoolsyncDeadlineSummary = $('#schoolsync-deadline-summary');

const PANEL_REFRESH_TICK_MS = 30_000;
let panelLastSyncedAtIso = null;
let panelTickerHandle = null;
let panelRefreshInFlight = false;

function panelMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message));
        else resolve(reply);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function setPanelState(state) {
  // Mutually exclusive primary blocks. Other blocks (overdue, categorized,
  // summary, last-synced) are managed independently from the resolved data.
  schoolsyncAuthBanner.classList.toggle('hidden', state !== 'unauthenticated');
  schoolsyncLoading.classList.toggle('hidden', state !== 'loading');
  schoolsyncError.classList.toggle('hidden', state !== 'error');
  schoolsyncEmpty.classList.toggle('hidden', state !== 'empty');
  if (state !== 'ok' && state !== 'empty') {
    schoolsyncOverdueSection.classList.add('hidden');
    schoolsyncCategorized.innerHTML = '';
    schoolsyncDeadlineSummary.classList.add('hidden');
    schoolsyncDeadlineSummary.textContent = '';
  }
  // Refresh button is disabled in unauthenticated and loading-of-empty states
  // but always reachable in error so the user can retry without the inline button.
  schoolsyncRefreshBtn.disabled = state === 'unauthenticated' || panelRefreshInFlight;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDueBadge(dueIso) {
  const t = Date.parse(dueIso);
  if (!Number.isFinite(t)) return 'Due —';
  const d = new Date(t);
  return `Due ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function renderOverdue(overdueItems) {
  if (!overdueItems?.length) {
    schoolsyncOverdueSection.classList.add('hidden');
    schoolsyncOverdueList.innerHTML = '';
    return;
  }
  schoolsyncOverdueSection.classList.remove('hidden');
  schoolsyncOverdueList.innerHTML = overdueItems
    .map(
      (a) => `
    <div class="schoolsync-overdue-item">
      <span>${escapeHtml(a.title)} <span style="color:#a08080">· ${escapeHtml(a.subject || 'Unknown')}</span></span>
      <span class="due">${escapeHtml(formatDueBadge(a.dueDate))}</span>
    </div>`,
    )
    .join('');
}

function renderCategorized(groups) {
  if (!groups?.length) {
    schoolsyncCategorized.innerHTML = '';
    return;
  }
  schoolsyncCategorized.innerHTML = groups
    .map(
      (g) => `
    <div class="schoolsync-subject">
      <div class="schoolsync-subject-name">${escapeHtml(g.subject)}</div>
      ${(g.items || [])
        .map(
          (a) => `
        <div class="schoolsync-assignment">
          <span>${escapeHtml(a.title)}</span>
          <span class="due-badge">${escapeHtml(formatDueBadge(a.dueDate))}</span>
        </div>`,
        )
        .join('')}
    </div>`,
    )
    .join('');
}

function renderDeadlineSummary(text) {
  if (!text) {
    schoolsyncDeadlineSummary.classList.add('hidden');
    schoolsyncDeadlineSummary.textContent = '';
    return;
  }
  schoolsyncDeadlineSummary.classList.remove('hidden');
  schoolsyncDeadlineSummary.textContent = text;
}

function tickLastSynced() {
  schoolsyncLastSynced.textContent = panelLastSyncedAtIso
    ? formatLastSynced(panelLastSyncedAtIso, Date.now())
    : 'Last synced: —';
}

function startLastSyncedTicker() {
  if (panelTickerHandle) return;
  panelTickerHandle = setInterval(tickLastSynced, PANEL_REFRESH_TICK_MS);
}

async function loadSchoolsyncPanel({ showLoading = true } = {}) {
  if (showLoading) setPanelState('loading');
  try {
    const reply = await panelMessage({ type: 'SPRITES_GET_PANEL_DATA' });
    if (!reply?.ok) throw new Error(reply?.error || 'panel data unavailable');
    const data = reply.data;
    panelLastSyncedAtIso = data.lastSyncedAt;
    tickLastSynced();
    if (data.status === 'unauthenticated') {
      setPanelState('unauthenticated');
      return;
    }
    renderOverdue(data.overdue);
    renderCategorized(data.categorized);
    renderDeadlineSummary(data.deadlineSummary);
    setPanelState(data.status === 'empty' ? 'empty' : 'ok');
  } catch (err) {
    schoolsyncErrorMessage.textContent = `Could not load assignments: ${err.message}`;
    setPanelState('error');
  }
}

async function handleSchoolsyncRefresh() {
  if (panelRefreshInFlight) return;
  panelRefreshInFlight = true;
  schoolsyncRefreshBtn.classList.add('is-loading');
  schoolsyncRefreshLabel.textContent = 'Refreshing';
  schoolsyncRefreshBtn.disabled = true;
  try {
    // Resolve the active user via the panel data first; the refresh message
    // requires an explicit user_id per the Lane 3 contract.
    const probe = await panelMessage({ type: 'SPRITES_GET_PANEL_DATA' });
    const userId = probe?.ok ? probe.data?.userId : null;
    if (!userId) {
      setPanelState('unauthenticated');
      return;
    }
    const refresh = await panelMessage({ type: 'SPRITES_REFRESH_NOW', user_id: userId });
    if (refresh?.reauth) {
      setPanelState('unauthenticated');
      return;
    }
    if (!refresh?.ok) {
      throw new Error(refresh?.error || 'refresh failed');
    }
    await loadSchoolsyncPanel({ showLoading: false });
  } catch (err) {
    schoolsyncErrorMessage.textContent = `Refresh failed: ${err.message}`;
    setPanelState('error');
  } finally {
    panelRefreshInFlight = false;
    schoolsyncRefreshBtn.classList.remove('is-loading');
    schoolsyncRefreshLabel.textContent = 'Refresh';
    schoolsyncRefreshBtn.disabled = false;
  }
}

function handleSchoolsyncConnect() {
  // Lane 2 (sprites/auth-session-backend) attaches a 'SPRITES_OAUTH_START'
  // handler that drives chrome.identity.launchWebAuthFlow. Lane 4's sign-in UI
  // panel exposes the same flow. From this dashboard panel we route the user
  // there by exposing the existing #signin-view if it is present, falling back
  // to dispatching the OAuth-start message directly.
  const signinView = document.getElementById('signin-view');
  if (signinView) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    signinView.classList.remove('hidden');
    return;
  }
  // No signin-view yet (Lane 4 sign-in PR not merged) — fall back to direct
  // message dispatch so the dashboard is still actionable.
  panelMessage({ type: 'SPRITES_OAUTH_START' }).catch(() => {
    schoolsyncErrorMessage.textContent =
      'Sign-in flow unavailable. Open the sprites.dev sign-in card.';
    setPanelState('error');
  });
}

if (schoolsyncRefreshBtn) {
  schoolsyncRefreshBtn.addEventListener('click', handleSchoolsyncRefresh);
  schoolsyncRetryBtn.addEventListener('click', () => loadSchoolsyncPanel());
  schoolsyncConnectBtn.addEventListener('click', handleSchoolsyncConnect);

  // Lane 3's polling worker emits no SSE/invalidation broadcast inside an MV3
  // worker; chrome.storage.onChanged is the equivalent signal. When the
  // raw_assignments_cache or processed_assignments_cache row for the active
  // user is rewritten, refetch the panel without a manual reload.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    const touchedAssignments = Object.keys(changes).some(
      (k) =>
        k.startsWith('sprites:row:raw_assignments_cache:') ||
        k.startsWith('sprites:row:processed_assignments_cache:'),
    );
    if (touchedAssignments) {
      loadSchoolsyncPanel({ showLoading: false });
    }
  });

  startLastSyncedTicker();
  loadSchoolsyncPanel();
}

// Go
init();

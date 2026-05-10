/**
 * SchoolSync Popup — UI controller for the extension popup.
 *
 * The popup now serves two flows:
 *   1. Sprites.dev OAuth sign-in (PRD Lane 4). Gates everything else: if the
 *      user has not completed sprites.dev consent, only the signin-view is
 *      visible. Sign-in talks to the service-worker handlers via
 *      `src/lib/sprites-ui.js` and never touches access tokens directly.
 *   2. Capsule sync (the existing SchoolSync flow). Surfaces only after
 *      sprites sign-in so the popup has a single auth surface.
 */

import {
  runOAuthFlow,
  getSpritesUserId,
  clearSpritesUserId,
  withReauthGuard,
} from '../lib/sprites-ui.js';

const $ = (sel) => document.querySelector(sel);

// Views
const signinView = $('#signin-view');
const setupView = $('#setup-view');
const mainView = $('#main-view');

// Sprites sign-in elements
const signinBtn = $('#signin-btn');
const signinLabel = $('#signin-label');
const signinPending = $('#signin-pending');
const signinAuthorizing = $('#signin-authorizing');
const signinError = $('#signin-error');

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

/**
 * Decide which view to show on popup open. The sprites.dev sign-in is the
 * outermost gate: without a `sprites_user_id` in storage we render only
 * the signin-view, regardless of Capsule setup state. After sign-in the
 * Capsule setup-vs-main decision is unchanged from before.
 */
async function init() {
  const userId = await getSpritesUserId();
  if (!userId) {
    showSigninView();
    return;
  }
  const config = await chrome.storage.local.get(['capsule_endpoint', 'encrypted_token']);
  if (config.capsule_endpoint && config.encrypted_token) {
    await showMainView();
  } else {
    showSetupView();
  }
}

function showSigninView() {
  signinView.classList.remove('hidden');
  setupView.classList.add('hidden');
  mainView.classList.add('hidden');
  // Reset transient sign-in state so a re-entry from reauth looks clean.
  signinPending.classList.add('hidden');
  signinAuthorizing.classList.add('hidden');
  signinError.classList.add('hidden');
  signinBtn.disabled = false;
  signinLabel.textContent = 'Sign in with sprites.dev';
}

function showSetupView() {
  signinView.classList.add('hidden');
  setupView.classList.remove('hidden');
  mainView.classList.add('hidden');
}

async function showMainView() {
  signinView.classList.add('hidden');
  setupView.classList.add('hidden');
  mainView.classList.remove('hidden');
  await refreshStatus();
  await refreshSyncLog();
  await detectCurrentPage();
}

// --- Sprites.dev sign-in ---

/**
 * Click handler for "Sign in with sprites.dev". Drives the full PKCE flow
 * through `src/lib/sprites-ui.js` and only navigates onward after the
 * service worker confirms a `user_id`. The intermediate "Authorizing…"
 * note appears only when the callback exchange takes longer than 500ms,
 * matching the PRD acceptance criterion.
 */
signinBtn.addEventListener('click', async () => {
  signinError.classList.add('hidden');
  signinError.textContent = '';
  signinAuthorizing.classList.add('hidden');
  signinPending.classList.remove('hidden');
  signinBtn.disabled = true;
  signinLabel.textContent = 'Signing in…';

  try {
    await runOAuthFlow({
      onAuthorizing: () => {
        signinPending.classList.add('hidden');
        signinAuthorizing.classList.remove('hidden');
      },
    });
    // Sign-in succeeded. Hand off to the existing setup/main router.
    signinPending.classList.add('hidden');
    signinAuthorizing.classList.add('hidden');
    await init();
  } catch (err) {
    signinPending.classList.add('hidden');
    signinAuthorizing.classList.add('hidden');
    showError(signinError, err?.message || 'Sign in failed. Please try again.');
  } finally {
    signinBtn.disabled = false;
    signinLabel.textContent = 'Sign in with sprites.dev';
  }
});

/**
 * Public reauth guard for any popup-side API call that hits a sprites.dev
 * endpoint. Sibling lanes (polling worker, dashboard) call this so the
 * popup automatically returns to sign-in when a 401-equivalent surfaces.
 *
 * @template T
 * @param {() => Promise<T>} call
 * @returns {Promise<T>}
 */
export async function callWithReauth(call) {
  return withReauthGuard(call, { onReauth: () => showSigninView() });
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

// Disconnect: clears Capsule config, alarms, AND the sprites.dev popup
// session pointer so the user lands back on the sign-in gate. The encrypted
// user_sessions blob is wiped here as part of `storage.local.clear()`,
// which is the desired behaviour for an explicit disconnect (vs the silent
// reauth path, which only forgets the popup-side identifier).
disconnectBtn.addEventListener('click', async () => {
  if (!confirm('Disconnect from Capsule? Your synced data will remain in Capsule.')) return;
  await chrome.storage.local.clear();
  await chrome.alarms.clear('schoolsync-auto');
  showSigninView();
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

// Go
init();

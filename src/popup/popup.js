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
      const labels = {
        roster: `📋 Roster: ${result.count} students`,
        export: `📥 Export: ${result.count} students`,
        gradebook: `📊 Gradebook: ${result.count} students`,
        attendance: `✅ Attendance: ${result.count} records`,
      };
      pageInfo.textContent = labels[result.pageType] || `${result.count} records detected`;
      syncBtn.classList.remove('hidden');
      syncBtn.disabled = false;
      syncBtn.dataset.tabId = tab.id;
    } else {
      pageInfo.textContent = 'PowerSchool page detected — no parseable data found';
      syncBtn.classList.add('hidden');
    }
  } catch {
    pageInfo.textContent = 'Navigate to a PowerSchool page to sync';
    syncBtn.classList.add('hidden');
  }
}

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

// Go
init();

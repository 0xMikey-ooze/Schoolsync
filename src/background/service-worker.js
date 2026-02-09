/**
 * SchoolSync Service Worker — orchestrates sync, manages scheduled syncs,
 * intercepts CSV downloads.
 */

const ALARM_NAME = 'schoolsync-auto';

// Track detected pages across tabs
const detectedPages = new Map();

// --- Message Handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'PAGE_DETECTED':
      handlePageDetected(msg, sender);
      break;

    case 'WATCH_DOWNLOAD':
      watchForCSVDownload(msg.url);
      break;

    case 'TRIGGER_SYNC':
      triggerSync(msg.tabId, msg.passphrase).then(sendResponse);
      return true;

    case 'TRIGGER_DEEP_SYNC':
      syncStudentData(msg.students, msg.passphrase).then(sendResponse);
      return true;

    case 'OPEN_POPUP':
      // Can't programmatically open popup in MV3, but can set badge
      if (sender.tab?.id) {
        chrome.action.setBadgeText({ text: '!', tabId: sender.tab.id });
        chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId: sender.tab.id });
      }
      break;

    case 'GET_STATUS':
      getStatus().then(sendResponse);
      return true;
  }
});

/**
 * Handle page detection from content script.
 */
function handlePageDetected(msg, sender) {
  if (!sender.tab?.id) return;
  detectedPages.set(sender.tab.id, {
    pageType: msg.pageType,
    url: msg.url,
    title: msg.title,
    timestamp: Date.now(),
  });

  // Update badge
  const icons = { roster: '📋', export: '📥', gradebook: '📊', attendance: '✅' };
  chrome.action.setBadgeText({
    text: icons[msg.pageType] ? '●' : '',
    tabId: sender.tab.id,
  });
  chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId: sender.tab.id });
}

/**
 * Trigger sync for a specific tab.
 * @param {number} tabId
 * @param {string} passphrase
 * @returns {Promise<{ success: boolean, count: number, error?: string }>}
 */
async function triggerSync(tabId, passphrase) {
  try {
    // Ask content script to parse the page
    const result = await chrome.tabs.sendMessage(tabId, { type: 'PARSE_PAGE' });

    if (!result || !result.data || result.count === 0) {
      // If export page returned a CSV link, fetch it
      if (result?.csvLink) {
        return await fetchAndParseCSV(result.csvLink, tabId, passphrase);
      }
      return { success: false, count: 0, error: 'No data found on page' };
    }

    if (result.pageType === 'roster' || result.pageType === 'export') {
      return await syncStudentData(result.data, passphrase);
    }

    if (result.pageType === 'gradebook') {
      return await syncGradeData(result.data, passphrase);
    }

    if (result.pageType === 'attendance') {
      return await syncAttendanceData(result.data, passphrase);
    }

    return { success: true, count: result.count };
  } catch (err) {
    return { success: false, count: 0, error: err.message };
  }
}

/**
 * Sync student records to Capsule with diffing.
 */
async function syncStudentData(students, passphrase) {
  // Get stored hashes for diffing
  const result = await chrome.storage.local.get('student_hashes');
  const existingHashes = result.student_hashes || {};

  // Hash and diff
  const { changed, newHashes } = await diffStudentsInWorker(students, existingHashes);

  if (changed.length === 0) {
    return { success: true, count: 0, message: 'No changes detected' };
  }

  // Push to Capsule API
  const syncResult = await pushToCapsule(changed, passphrase);

  // Update stored hashes
  await chrome.storage.local.set({ student_hashes: newHashes });

  // Record sync
  const entry = {
    timestamp: Date.now(),
    studentCount: changed.length,
    status: syncResult.failed === 0 ? 'success' : 'partial',
    errors: syncResult.errors,
  };
  await recordSyncEntry(entry);

  return {
    success: syncResult.failed === 0,
    count: changed.length,
    total: students.length,
    error: syncResult.errors.length > 0 ? syncResult.errors[0] : undefined,
  };
}

async function syncGradeData(grades, passphrase) {
  const config = await chrome.storage.local.get('capsule_endpoint');
  const tokenResult = await chrome.storage.local.get('encrypted_token');
  if (!config.capsule_endpoint || !tokenResult.encrypted_token) {
    return { success: false, count: 0, error: 'Not configured' };
  }

  // For now, store grades locally until Capsule grades API exists
  const key = `grades_${Date.now()}`;
  await chrome.storage.local.set({ [key]: grades });
  return { success: true, count: grades.length, message: 'Grades cached locally' };
}

async function syncAttendanceData(records, passphrase) {
  // Similar to grades — cache until API ready
  const key = `attendance_${Date.now()}`;
  await chrome.storage.local.set({ [key]: records });
  return { success: true, count: records.length, message: 'Attendance cached locally' };
}

/**
 * Fetch a CSV from URL and parse it.
 */
async function fetchAndParseCSV(url, tabId, passphrase) {
  try {
    const response = await fetch(url);
    const csvText = await response.text();

    // Send to content script for parsing
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'PARSE_CSV_TEXT',
      csvText,
    });

    if (result?.students?.length > 0) {
      return await syncStudentData(result.students, passphrase);
    }

    return { success: false, count: 0, error: 'CSV contained no student data' };
  } catch (err) {
    return { success: false, count: 0, error: `CSV fetch failed: ${err.message}` };
  }
}

/**
 * Push student data to Capsule API.
 */
async function pushToCapsule(students, passphrase) {
  const config = await chrome.storage.local.get(['capsule_endpoint', 'encrypted_token']);
  if (!config.capsule_endpoint || !config.encrypted_token) {
    return { success: 0, failed: students.length, errors: ['Not configured. Set Capsule endpoint in settings.'] };
  }

  // Decrypt token
  let token;
  try {
    token = await decryptToken(config.encrypted_token, passphrase);
  } catch {
    return { success: 0, failed: students.length, errors: ['Invalid passphrase'] };
  }

  const BATCH = 50;
  const result = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < students.length; i += BATCH) {
    const batch = students.slice(i, i + BATCH);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(`${config.capsule_endpoint}/api/v1/sync/students`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Source': 'schoolsync-extension',
        },
        body: JSON.stringify({ students: batch }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (resp.ok) {
        result.success += batch.length;
      } else {
        result.failed += batch.length;
        const body = await resp.text().catch(() => '');
        result.errors.push(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      result.failed += batch.length;
      result.errors.push(err.message);
    }
  }

  return result;
}

/**
 * Diff students using SHA-256 hashing.
 */
async function diffStudentsInWorker(students, existingHashes) {
  const changed = [];
  const newHashes = {};

  for (const student of students) {
    const normalized = JSON.stringify({
      id: student.sourcedId,
      fn: student.firstName,
      ln: student.lastName,
      gr: student.gradeLevel || '',
      hr: student.homeRoom || '',
      es: student.enrollStatus || '',
      em: student.email || '',
      si: student.schoolId || '',
    });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
    const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

    newHashes[student.sourcedId] = hash;
    if (existingHashes[student.sourcedId] !== hash) {
      changed.push(student);
    }
  }

  return { changed, newHashes };
}

async function decryptToken(encrypted, passphrase) {
  const SALT_BYTES = 16;
  const IV_BYTES = 12;
  const raw = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const salt = raw.slice(0, SALT_BYTES);
  const iv = raw.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const ciphertext = raw.slice(SALT_BYTES + IV_BYTES);

  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

/**
 * Watch for CSV downloads (from export page clicks).
 */
function watchForCSVDownload(sourceUrl) {
  const listener = (downloadItem) => {
    if (downloadItem.filename?.endsWith('.csv') || downloadItem.mime === 'text/csv') {
      // Read the file after download completes
      chrome.downloads.onChanged.addListener(function onChange(delta) {
        if (delta.id === downloadItem.id && delta.state?.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChange);
          // Notify popup that a CSV was downloaded
          chrome.runtime.sendMessage({
            type: 'CSV_DOWNLOADED',
            filename: downloadItem.filename,
            url: downloadItem.url,
          });
        }
      });
    }
  };

  chrome.downloads?.onCreated?.addListener(listener);
  // Remove listener after 30s
  setTimeout(() => chrome.downloads?.onCreated?.removeListener(listener), 30_000);
}

// --- Scheduled Sync ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Auto-sync: find any PowerSchool tabs and sync them
  const tabs = await chrome.tabs.query({ url: '*://*.powerschool.com/*' });
  for (const tab of tabs) {
    if (detectedPages.has(tab.id)) {
      // Can't auto-sync without passphrase — just set badge
      chrome.action.setBadgeText({ text: '⟳', tabId: tab.id });
    }
  }
});

/**
 * Set up or clear the auto-sync alarm.
 * @param {boolean} enabled
 * @param {number} intervalHours
 */
export async function configureAutoSync(enabled, intervalHours) {
  await chrome.alarms.clear(ALARM_NAME);
  if (enabled) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalHours * 60 });
  }
  await chrome.storage.local.set({ sync_schedule: { enabled, intervalHours } });
}

async function getStatus() {
  const result = await chrome.storage.local.get(['last_sync', 'sync_schedule', 'capsule_endpoint']);
  return {
    lastSync: result.last_sync || null,
    schedule: result.sync_schedule || { enabled: false, intervalHours: 24 },
    configured: !!result.capsule_endpoint,
    detectedPages: Object.fromEntries(detectedPages),
  };
}

async function recordSyncEntry(entry) {
  await chrome.storage.local.set({ last_sync: entry });
  const result = await chrome.storage.local.get('sync_log');
  const log = result.sync_log || [];
  log.unshift(entry);
  await chrome.storage.local.set({ sync_log: log.slice(0, 50) });
}

// Clean up detected pages when tabs close
chrome.tabs.onRemoved.addListener((tabId) => detectedPages.delete(tabId));

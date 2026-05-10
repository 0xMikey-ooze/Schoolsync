/**
 * Periodic + on-demand Schoolsync snapshot poller.
 *
 * Chrome MV3 service workers cannot use setInterval reliably (the worker is
 * evicted), so periodic work uses chrome.alarms. Snapshots are stored in
 * chrome.storage.local under SNAPSHOT_KEY as a ring buffer capped at
 * MAX_SNAPSHOTS entries (newest first).
 *
 * A "snapshot" records the pollable state observed at tick time:
 *   { ts, source: 'periodic'|'on-demand', detectedPages: {...}, status }
 * The fetch payload from a remote Schoolsync API is intentionally NOT invented
 * here — `fetchPayload` is injected by the caller so this module stays honest
 * about what data it has.
 */

export const SCHOOLSYNC_POLL_ALARM = 'schoolsync-poll';
export const SNAPSHOT_KEY = 'schoolsync_snapshots';
export const MAX_SNAPSHOTS = 3;
export const POLL_INTERVAL_MINUTES = 15;

/**
 * Register (or re-register) the periodic poll alarm.
 * Idempotent — clears any prior alarm of the same name first.
 */
export async function configureSchoolsyncPoll(intervalMinutes = POLL_INTERVAL_MINUTES) {
  await chrome.alarms.clear(SCHOOLSYNC_POLL_ALARM);
  chrome.alarms.create(SCHOOLSYNC_POLL_ALARM, { periodInMinutes: intervalMinutes });
}

/**
 * Take a snapshot now. Stores it in the ring buffer and returns it.
 * @param {object} opts
 * @param {'periodic'|'on-demand'} opts.source
 * @param {object} [opts.detectedPages] Observable state to record.
 * @param {(opts: object) => Promise<object>} [opts.fetchPayload] Optional injected fetcher.
 * @returns {Promise<object>} the recorded snapshot
 */
export async function snapshotNow({ source, detectedPages = {}, fetchPayload } = {}) {
  if (source !== 'periodic' && source !== 'on-demand') {
    throw new Error(`snapshotNow: invalid source "${source}"`);
  }
  let payload = null;
  let status = 'ok';
  let error = null;
  if (typeof fetchPayload === 'function') {
    try {
      payload = await fetchPayload({ source });
    } catch (err) {
      status = 'fetch_error';
      error = err?.message ?? String(err);
    }
  } else {
    status = 'no_fetcher';
  }
  const snapshot = {
    ts: Date.now(),
    source,
    status,
    detectedPages,
    payload,
    error,
  };
  await appendSnapshot(snapshot);
  console.log(`[schoolsync-poll] tick source=${source} status=${status} ts=${new Date(snapshot.ts).toISOString()}`);
  return snapshot;
}

/**
 * @returns {Promise<object[]>} snapshots, newest first.
 */
export async function listSnapshots() {
  const result = await chrome.storage.local.get(SNAPSHOT_KEY);
  return result[SNAPSHOT_KEY] || [];
}

export async function clearSnapshots() {
  await chrome.storage.local.remove(SNAPSHOT_KEY);
}

async function appendSnapshot(snapshot) {
  const existing = await listSnapshots();
  const next = [snapshot, ...existing].slice(0, MAX_SNAPSHOTS);
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: next });
  return next;
}

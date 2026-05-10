/**
 * Dashboard page entry point. The render logic and chrome.runtime
 * contract live in src/lib/sprites-dashboard.js — this file just owns
 * the page-level state machine and wires DOM events.
 *
 * Auth note (forbidden path): we do NOT touch session creation, OAuth
 * tokens, or session-id cookies here. We read the current user_id from
 * chrome.storage.local under the key Lane 2/5 already established
 * ('sprites:current_user_id'); when missing, we redirect to the popup
 * sign-in view rather than handling auth ourselves.
 */

import {
  fetchProcessed,
  refreshAndFetch,
  renderDashboard,
} from '../lib/sprites-dashboard.js';

const USER_ID_KEY = 'sprites:current_user_id';

const state = {
  loading: false,
  error: null,
  processed: null,
  now: Date.now(),
  userId: null,
  onRefresh: handleRefresh,
  onRetry: handleRetry,
};

const root = document.getElementById('dashboard-root');

async function readUserId() {
  const out = await chrome.storage.local.get(USER_ID_KEY);
  return out?.[USER_ID_KEY] || null;
}

function paint() {
  state.now = Date.now();
  renderDashboard(root, state);
}

async function loadInitial() {
  state.userId = await readUserId();
  if (!state.userId) {
    state.error = 'Not signed in. Open the extension popup to sign in with sprites.dev.';
    paint();
    return;
  }
  state.loading = true;
  state.error = null;
  paint();
  try {
    const reply = await fetchProcessed(state.userId);
    if (!reply?.ok) {
      throw new Error(reply?.error || 'Failed to load assignments');
    }
    state.processed = reply.processed || { categories: [], deadlineSummary: '', fetchedAt: new Date().toISOString() };
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.loading = false;
    paint();
  }
}

async function handleRefresh() {
  if (state.loading || !state.userId) return;
  state.loading = true;
  state.error = null;
  paint();
  try {
    const refresh = await refreshAndFetch(state.userId);
    if (!refresh?.ok) {
      throw new Error(refresh?.error || 'Refresh failed');
    }
    // refreshAndFetch returns processed inline when available; fall back to a
    // fresh fetch so the cached path is exercised too.
    const reply = refresh.processed
      ? { ok: true, processed: refresh.processed }
      : await fetchProcessed(state.userId);
    if (!reply?.ok) {
      throw new Error(reply?.error || 'Failed to load assignments');
    }
    state.processed = reply.processed;
  } catch (e) {
    state.error = e?.message || String(e);
  } finally {
    state.loading = false;
    paint();
  }
}

async function handleRetry() {
  if (state.processed) {
    return handleRefresh();
  }
  return loadInitial();
}

// Re-paint the relative timestamp every 30 s without re-fetching.
setInterval(() => {
  if (state.processed) paint();
}, 30_000);

loadInitial();

/**
 * Node-runnable tests for src/lib/sprites-dashboard.js (Lane 6).
 *
 * Run: node test/sprites-dashboard.test.mjs
 *
 * Uses a tiny hand-rolled DOM stub — sufficient for the dashboard's
 * declarative renderDashboard() because it only relies on
 *   document.createElement, element.appendChild, addEventListener,
 *   setAttribute, dataset, className, and innerHTML='' (reset).
 *
 * No JSDOM dependency: keeps the extension's "no npm install for tests"
 * pattern consistent with sprites-llm.test.mjs and sprites-ui.test.mjs.
 */

import assert from 'node:assert/strict';

import {
  PRIORITY_RANK,
  sortCategories,
  relativeTime,
  fetchProcessed,
  refreshAndFetch,
  renderDashboard,
} from '../src/lib/sprites-dashboard.js';

/* ---------- minimal DOM stub ---------- */

function makeDoc() {
  function makeNode(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      attrs: {},
      dataset: {},
      listeners: {},
      style: {},
      _text: '',
      ownerDocument: null,
      get className() {
        return this.attrs.class || '';
      },
      set className(v) {
        this.attrs.class = v;
      },
      set innerHTML(v) {
        if (v === '') {
          this.children = [];
          this._text = '';
        } else {
          this._text = v;
        }
      },
      get innerHTML() {
        return this._text || this.children.map(serialize).join('');
      },
      get textContent() {
        if (tag === '#text') return this._text;
        return this.children.map((c) => c.textContent || '').join('');
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(k, v) {
        this.attrs[k] = String(v);
      },
      getAttribute(k) {
        return this.attrs[k] ?? null;
      },
      addEventListener(name, fn) {
        (this.listeners[name] ||= []).push(fn);
      },
      dispatch(name) {
        for (const fn of this.listeners[name] || []) fn();
      },
      // querySelector(All) — minimal CSS support: tag, [data-testid="x"], or .class
      querySelectorAll(sel) {
        const out = [];
        walk(this, (n) => {
          if (matches(n, sel)) out.push(n);
        });
        return out;
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
    };
    return node;
  }
  function makeText(text) {
    const t = makeNode('#text');
    t._text = text;
    return t;
  }
  function walk(n, fn) {
    for (const c of n.children) {
      fn(c);
      walk(c, fn);
    }
  }
  function matches(node, sel) {
    sel = sel.trim();
    let m;
    if ((m = sel.match(/^\[data-testid="(.+)"\]$/))) {
      return node.attrs['data-testid'] === m[1];
    }
    if (sel.startsWith('.')) {
      const c = sel.slice(1);
      return (node.attrs.class || '').split(/\s+/).includes(c);
    }
    return node.tagName === sel.toUpperCase();
  }
  function serialize(n) {
    if (n.tagName === '#TEXT') return n._text;
    return `<${n.tagName.toLowerCase()}>${n.children.map(serialize).join('')}</${n.tagName.toLowerCase()}>`;
  }
  const doc = {
    createElement: (tag) => {
      const n = makeNode(tag);
      n.ownerDocument = doc;
      return n;
    },
    createTextNode: (t) => {
      const n = makeText(t);
      n.ownerDocument = doc;
      return n;
    },
  };
  const root = doc.createElement('div');
  return { doc, root };
}

/* ---------- tests ---------- */

let pass = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
    pass += 1;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}
async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ok ${name}`);
    pass += 1;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log('# sprites-dashboard.test.mjs');

test('PRIORITY_RANK orders high < medium < low', () => {
  assert.equal(PRIORITY_RANK.high, 0);
  assert.equal(PRIORITY_RANK.medium, 1);
  assert.equal(PRIORITY_RANK.low, 2);
});

test('sortCategories returns [] for non-array input', () => {
  assert.deepEqual(sortCategories(null), []);
  assert.deepEqual(sortCategories(undefined), []);
  assert.deepEqual(sortCategories({}), []);
});

test('sortCategories sorts subjects alphabetically and does not mutate input', () => {
  const input = [
    { subject: 'Math', assignments: [] },
    { subject: 'Art', assignments: [] },
    { subject: 'Biology', assignments: [] },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = sortCategories(input);
  assert.deepEqual(input, snapshot, 'input not mutated');
  assert.deepEqual(
    out.map((c) => c.subject),
    ['Art', 'Biology', 'Math'],
  );
});

test('sortCategories: overdue first, then priority high<medium<low, then earliest dueDate', () => {
  const input = [
    {
      subject: 'Math',
      assignments: [
        { title: 'A late', dueDate: '2026-04-01', overdue: true, priority: 'low' },
        { title: 'B today high', dueDate: '2026-05-09', overdue: false, priority: 'high' },
        { title: 'C tomorrow medium', dueDate: '2026-05-10', overdue: false, priority: 'medium' },
        { title: 'D today medium', dueDate: '2026-05-09', overdue: false, priority: 'medium' },
      ],
    },
  ];
  const out = sortCategories(input)[0].assignments;
  assert.deepEqual(
    out.map((a) => a.title),
    ['A late', 'B today high', 'D today medium', 'C tomorrow medium'],
  );
});

test('relativeTime: just now under 30 s', () => {
  const now = Date.parse('2026-05-09T12:00:00Z');
  assert.equal(relativeTime('2026-05-09T11:59:50Z', now), 'just now');
});

test('relativeTime: minutes < 1h', () => {
  const now = Date.parse('2026-05-09T12:03:00Z');
  assert.equal(relativeTime('2026-05-09T12:00:00Z', now), '3 min ago');
});

test('relativeTime: hours < 1d', () => {
  const now = Date.parse('2026-05-09T15:00:00Z');
  assert.equal(relativeTime('2026-05-09T12:00:00Z', now), '3 hr ago');
});

test('relativeTime: days', () => {
  const now = Date.parse('2026-05-12T12:00:00Z');
  assert.equal(relativeTime('2026-05-09T12:00:00Z', now), '3 days ago');
});

test('relativeTime: never for missing/invalid', () => {
  assert.equal(relativeTime(null), 'never');
  assert.equal(relativeTime('not-a-date'), 'never');
});

await asyncTest('fetchProcessed sends SPRITES_GET_PROCESSED_ASSIGNMENTS', async () => {
  let captured = null;
  const stub = async (msg) => {
    captured = msg;
    return { ok: true, processed: { categories: [], deadlineSummary: 'x', fetchedAt: '2026-05-09T12:00:00Z' }, source: 'cache' };
  };
  const reply = await fetchProcessed('user-42', stub);
  assert.deepEqual(captured, { type: 'SPRITES_GET_PROCESSED_ASSIGNMENTS', user_id: 'user-42' });
  assert.equal(reply.ok, true);
});

await asyncTest('fetchProcessed throws when userId missing', async () => {
  await assert.rejects(() => fetchProcessed('', async () => ({})), /userId is required/);
});

await asyncTest('refreshAndFetch sends SPRITES_REFRESH_AND_PROCESS', async () => {
  let captured = null;
  const stub = async (msg) => {
    captured = msg;
    return { ok: true, refresh: { changed: true }, processed: { categories: [], deadlineSummary: '', fetchedAt: '2026-05-09T12:00:00Z' } };
  };
  const reply = await refreshAndFetch('u', stub);
  assert.deepEqual(captured, { type: 'SPRITES_REFRESH_AND_PROCESS', user_id: 'u' });
  assert.equal(reply.refresh.changed, true);
});

await asyncTest('refreshAndFetch throws when userId missing', async () => {
  await assert.rejects(() => refreshAndFetch(null, async () => ({})), /userId is required/);
});

test('renderDashboard: empty state when processed has zero categories', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: { categories: [], deadlineSummary: '', fetchedAt: '2026-05-09T12:00:00Z' },
    now: Date.parse('2026-05-09T12:01:00Z'),
  });
  assert.ok(root.querySelector('[data-testid="empty-state"]'), 'empty state visible');
  assert.equal(
    root.querySelector('[data-testid="empty-state"]').textContent,
    'No assignments found',
  );
});

test('renderDashboard: deadline summary banner renders', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: {
      categories: [],
      deadlineSummary: '3 assignments due this week',
      fetchedAt: '2026-05-09T12:00:00Z',
    },
    now: Date.parse('2026-05-09T12:01:00Z'),
  });
  const banner = root.querySelector('[data-testid="deadline-summary"]');
  assert.ok(banner, 'banner exists');
  assert.equal(banner.textContent, '3 assignments due this week');
});

test('renderDashboard: overdue rows are visually distinct', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: {
      categories: [
        {
          subject: 'Math',
          assignments: [
            { title: 'Late paper', dueDate: '2026-04-01', overdue: true, priority: 'high' },
            { title: 'Quiz', dueDate: '2026-05-15', overdue: false, priority: 'medium' },
          ],
        },
      ],
      deadlineSummary: 'one overdue',
      fetchedAt: '2026-05-09T12:00:00Z',
    },
    now: Date.parse('2026-05-09T12:01:00Z'),
  });
  const rows = root.querySelectorAll('[data-testid="assignment-row"]');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attrs['data-overdue'], 'true', 'overdue row first');
  assert.ok(
    rows[0].attrs.class.includes('sprites-dashboard__row--overdue'),
    'overdue style class on row',
  );
  assert.ok(root.querySelector('[data-testid="overdue-badge"]'), 'overdue badge visible');
});

test('renderDashboard: footer shows relative fetchedAt', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: { categories: [], deadlineSummary: '', fetchedAt: '2026-05-09T12:00:00Z' },
    now: Date.parse('2026-05-09T12:03:00Z'),
  });
  const footer = root.querySelector('[data-testid="fetched-at"]');
  assert.equal(footer.textContent, 'Last updated 3 min ago');
});

test('renderDashboard: refresh button disabled and spinner visible while loading', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: true,
    error: null,
    processed: null,
    now: Date.now(),
  });
  const btn = root.querySelector('[data-testid="refresh-button"]');
  assert.ok(btn, 'refresh button rendered');
  assert.equal(btn.attrs.disabled, 'disabled');
  assert.ok(root.querySelector('[data-testid="refresh-spinner"]'), 'spinner visible');
});

test('renderDashboard: refresh button click calls onRefresh', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  let clicks = 0;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: null,
    now: Date.now(),
    onRefresh: () => {
      clicks += 1;
    },
  });
  root.querySelector('[data-testid="refresh-button"]').dispatch('click');
  assert.equal(clicks, 1);
});

test('renderDashboard: error state shows retry button', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  let retried = 0;
  renderDashboard(root, {
    loading: false,
    error: 'network down',
    processed: null,
    now: Date.now(),
    onRetry: () => {
      retried += 1;
    },
  });
  const errBox = root.querySelector('[data-testid="error-state"]');
  assert.ok(errBox, 'error rendered');
  root.querySelector('[data-testid="retry-button"]').dispatch('click');
  assert.equal(retried, 1);
});

test('renderDashboard: never shows assignments without fetchedAt timestamp visible', () => {
  const { doc, root } = makeDoc();
  globalThis.document = doc;
  renderDashboard(root, {
    loading: false,
    error: null,
    processed: {
      categories: [
        {
          subject: 'Math',
          assignments: [
            { title: 'X', dueDate: '2026-05-15', overdue: false, priority: 'high' },
          ],
        },
      ],
      deadlineSummary: 'one due',
      fetchedAt: '2026-05-09T12:00:00Z',
    },
    now: Date.parse('2026-05-09T12:01:00Z'),
  });
  // Both must be present in the DOM together — no rows without footer.
  assert.ok(root.querySelector('[data-testid="assignment-row"]'));
  assert.ok(root.querySelector('[data-testid="fetched-at"]'));
});

console.log(`# ${pass} passed`);

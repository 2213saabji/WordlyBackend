// Step 4 of /sync: shared leaderboard counters (bumpGlobal, the cached
// read) and currentSyncValues(), which folds in the things that change an
// API's response without a write: the UTC day (daily mode), the IST day
// (Infinite), the week, and the tier config. SyncState / SyncGlobal are
// in-memory stubs, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { DEFAULT_TIER_CONFIG } = require('../utils/tierConfig');
const {
  SYNC_KEYS, bumpSync, bumpGlobal, globalVersions, resetGlobalCache, currentSyncValues, diffSync,
} = require('../utils/sync');

const USER = '507f1f77bcf86cd799439011';
const at = (iso) => new Date(iso).getTime();

let userDoc;
let globalDoc;
let globalReads;

beforeEach(() => {
  resetGlobalCache();
  userDoc = null;
  globalDoc = null;
  globalReads = 0;
  const inc = (doc, update) => {
    for (const [p, n] of Object.entries(update.$inc)) doc.v[p.slice(2)] = (doc.v[p.slice(2)] || 0) + n;
  };
  SyncState.updateOne = async (filter, update) => {
    userDoc = userDoc || { v: {} };
    inc(userDoc, update);
    return {};
  };
  SyncState.findOne = () => ({ select: () => ({ lean: async () => (userDoc ? structuredClone(userDoc) : null) }) });
  SyncGlobal.updateOne = async (filter, update) => {
    assert.equal(filter._id, 'global');
    globalDoc = globalDoc || { v: {} };
    inc(globalDoc, update);
    return {};
  };
  SyncGlobal.findById = (id) => {
    assert.equal(id, 'global');
    return { select: () => ({ lean: async () => { globalReads += 1; return globalDoc ? structuredClone(globalDoc) : null; } }) };
  };
});

const values = (iso, config = DEFAULT_TIER_CONFIG) => currentSyncValues(USER, config, at(iso));

// --- bumpGlobal / globalVersions ----------------------------------------------

test('globalVersions: nothing bumped yet reads as zeros', async () => {
  assert.deepEqual(await globalVersions(), { daily: 0, weekly: 0, infiniteBoard: 0 });
});

test('bumpGlobal increments only the given shared keys', async () => {
  await bumpGlobal(['daily', 'weekly']);
  await bumpGlobal('daily');
  await bumpGlobal(['me', 'bogus']); // not shared keys: ignored
  assert.deepEqual(await globalVersions(), { daily: 2, weekly: 1, infiniteBoard: 0 });
});

test('the shared counters are cached for 15 s per process', async () => {
  const t = at('2026-09-28T10:00:00Z');
  await globalVersions(t);
  await globalVersions(t + 14_000);
  assert.equal(globalReads, 1);
  await globalVersions(t + 15_000);
  assert.equal(globalReads, 2);
});

test('a bump on this instance clears its cache, so it sees its own change at once', async () => {
  const t = at('2026-09-28T10:00:00Z');
  await globalVersions(t);
  await bumpGlobal('infiniteBoard');
  assert.equal((await globalVersions(t + 1000)).infiniteBoard, 1);
});

test('bumpGlobal retries without upsert when two first bumps race', async () => {
  const real = SyncGlobal.updateOne;
  let calls = 0;
  SyncGlobal.updateOne = async (filter, update, opts) => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('dup');
      err.code = 11000;
      globalDoc = { v: {} }; // the other request created it
      throw err;
    }
    assert.ok(!opts || !opts.upsert);
    return real(filter, update, opts);
  };
  await bumpGlobal('daily');
  assert.equal((await globalVersions()).daily, 1);
});

test('bumpGlobal never throws', async () => {
  SyncGlobal.updateOne = async () => { throw new Error('db down'); };
  const orig = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.doesNotReject(bumpGlobal('daily'));
  } finally {
    console.error = orig;
  }
  assert.match(logged[0], /bumpGlobal\(daily\) failed/);
});

// --- currentSyncValues ----------------------------------------------------------

test('returns a value for every /sync key, so diffSync accepts it', async () => {
  const v = await values('2026-09-28T10:00:00Z');
  assert.deepEqual(Object.keys(v).sort(), Object.keys(SYNC_KEYS).sort());
  assert.doesNotThrow(() => diffSync(undefined, v, at('2026-09-28T10:00:00Z')));
});

test('daily mode uses the UTC day, Infinite the IST day', async () => {
  // 20:00 UTC on the 28th is 01:30 IST on the 29th.
  const v = await values('2026-09-28T20:00:00Z');
  assert.equal(v.today, '2026-09-28:0');
  assert.equal(v.daily, '2026-09-28:0');
  assert.equal(v.infinite, '2026-09-29:0');
  assert.equal(v.infiniteBoard, '2026-09-29:0');
});

test('weekly uses the UTC week start (Monday)', async () => {
  assert.equal((await values('2026-09-27T12:00:00Z')).weekly, '2026-09-21:0'); // Sunday → previous Monday
  assert.equal((await values('2026-09-28T00:00:00Z')).weekly, '2026-09-28:0'); // Monday
});

test('counters are folded in: user bumps and shared bumps each move their own keys', async () => {
  const before = await values('2026-09-28T10:00:00Z');
  await bumpSync(USER, ['today', 'infinite', 'mine']);
  await bumpGlobal('weekly');
  const after = await values('2026-09-28T10:00:01Z');
  const moved = Object.keys(before).filter((k) => before[k] !== after[k]).sort();
  assert.deepEqual(moved, ['infinite', 'mine', 'today', 'weekly']);
});

test('tiers changes when the tier config version or its edit time changes', async () => {
  const base = { ...DEFAULT_TIER_CONFIG, version: 3, updatedAt: new Date('2026-09-01T00:00:00Z') };
  const a = (await values('2026-09-28T10:00:00Z', base)).tiers;
  const edited = (await values('2026-09-28T10:00:00Z', { ...base, updatedAt: new Date('2026-09-02T00:00:00Z') })).tiers;
  const bumped = (await values('2026-09-28T10:00:00Z', { ...base, version: 4 })).tiers;
  assert.notEqual(a, edited);
  assert.notEqual(a, bumped);
  assert.equal((await values('2026-09-28T10:00:00Z', DEFAULT_TIER_CONFIG)).tiers, '0:0'); // no config document
});

// --- end to end with diffSync: the day boundaries flip the right flags --------

async function syncAcross(fromIso, toIso) {
  const first = diffSync(undefined, await values(fromIso), at(fromIso));
  return diffSync(first.syncToken, await values(toIso), at(toIso)).changed;
}

test('IST midnight (18:30 UTC) flips infinite and the tier board, not the daily-mode keys', async () => {
  const changed = await syncAcross('2026-09-28T18:25:00Z', '2026-09-28T18:35:00Z');
  assert.equal(changed.infinite, true, 'nightly tier reset');
  assert.equal(changed.infiniteBoard, true, "new day's stickDays");
  assert.equal(changed.today, false);
  assert.equal(changed.daily, false);
});

test('UTC midnight flips today and the daily board, not Infinite', async () => {
  const changed = await syncAcross('2026-09-28T23:55:00Z', '2026-09-29T00:05:00Z');
  assert.equal(changed.today, true, 'new daily word');
  assert.equal(changed.daily, true, "new day's board");
  assert.equal(changed.weekly, false, 'Tuesday: same week');
  assert.equal(changed.infinite, false);
});

test('UTC midnight into Monday also flips weekly', async () => {
  const changed = await syncAcross('2026-09-27T23:55:00Z', '2026-09-28T00:05:00Z');
  assert.equal(changed.weekly, true);
});

test('a quiet 10 minutes mid-day flips nothing', async () => {
  const changed = await syncAcross('2026-09-28T10:00:00Z', '2026-09-28T10:10:00Z');
  assert.deepEqual(Object.values(changed).filter(Boolean), []);
});

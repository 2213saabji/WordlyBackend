// utils/sync.js: the syncToken, the changed/unchanged rules (throttle and
// max-age safety net), and bumpSync(). SyncState is replaced by an
// in-memory stub, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SyncState = require('../models/SyncState');
const { SYNC_KEYS, MAX_AGE_MS, USER_KEYS, bumpSync, userVersions, encodeToken, decodeToken, diffSync } = require('../utils/sync');

const KEYS = Object.keys(SYNC_KEYS);
const THROTTLED = KEYS.filter((k) => SYNC_KEYS[k].throttleMs);
const T0 = 1_790_000_000_000;

// Every key at a baseline value; override some per test.
const current = (overrides = {}) => ({ ...Object.fromEntries(KEYS.map((k) => [k, 1])), today: '2026-09-28', ...overrides });
const allTrue = Object.fromEntries(KEYS.map((k) => [k, true]));
const allFalse = Object.fromEntries(KEYS.map((k) => [k, false]));

// --- diffSync ---------------------------------------------------------------

test('first sync (no token) reports every API as changed', () => {
  assert.deepEqual(diffSync(undefined, current(), T0).changed, allTrue);
});

test('malformed, oversized or old-format tokens are treated as a first sync', () => {
  const oldFormat = Buffer.from(JSON.stringify({ tv: 0, s: {} })).toString('base64url');
  for (const bad of ['', 'not-base64!!', 'eyJ4Ijox', oldFormat, 'a'.repeat(5000), 42, null]) {
    assert.deepEqual(diffSync(bad, current(), T0).changed, allTrue, `token ${String(bad).slice(0, 20)}`);
  }
});

test('nothing changed → every flag false', () => {
  const { syncToken } = diffSync(undefined, current(), T0);
  assert.deepEqual(diffSync(syncToken, current(), T0 + 5000).changed, allFalse);
});

test('only the keys whose value changed are true', () => {
  const { syncToken } = diffSync(undefined, current(), T0);
  const { changed } = diffSync(syncToken, current({ mine: 2, notifications: 7, today: '2026-09-29' }), T0 + 5000);
  assert.deepEqual(changed, { ...allFalse, mine: true, notifications: true, today: true });
});

test('a reported change is recorded, so the next sync is false again', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  const t2 = diffSync(t1, current({ me: 2 }), T0 + 5000).syncToken;
  assert.equal(diffSync(t2, current({ me: 2 }), T0 + 10000).changed.me, false);
});

test('an unreported (lost) response: resending the old token reports the change again', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  diffSync(t1, current({ me: 2 }), T0 + 5000); // response never reached the app
  assert.equal(diffSync(t1, current({ me: 2 }), T0 + 10000).changed.me, true);
});

test('each device keeps its own token: one device syncing does not hide changes from another', () => {
  const phone = diffSync(undefined, current(), T0).syncToken;
  const laptop = diffSync(undefined, current(), T0).syncToken;
  diffSync(phone, current({ mine: 2 }), T0 + 5000);
  assert.equal(diffSync(laptop, current({ mine: 2 }), T0 + 6000).changed.mine, true);
});

test('leaderboards: a change within 60 s of the last fetch is held back, then reported', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  const bumped = current(Object.fromEntries(THROTTLED.map((k) => [k, 2])));

  const early = diffSync(t1, bumped, T0 + 30_000);
  for (const k of THROTTLED) assert.equal(early.changed[k], false, `${k} at 30 s`);

  // Frequent syncs must not keep postponing it: the clock runs from the
  // last *fetch*, not the last sync.
  const later = diffSync(early.syncToken, bumped, T0 + 60_000);
  for (const k of THROTTLED) assert.equal(later.changed[k], true, `${k} at 60 s`);
});

test('non-leaderboard keys are never throttled', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  const { changed } = diffSync(t1, current({ me: 2, infinite: 2 }), T0 + 1000);
  assert.equal(changed.me, true);
  assert.equal(changed.infinite, true);
});

test('safety net: anything last fetched 15+ minutes ago is reported as changed', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  assert.deepEqual(diffSync(t1, current(), T0 + MAX_AGE_MS - 1).changed, allFalse);
  assert.deepEqual(diffSync(t1, current(), T0 + MAX_AGE_MS).changed, allTrue);
});

test('the safety net is per key: a key refetched recently is not reset by it', () => {
  const t1 = diffSync(undefined, current(), T0).syncToken;
  const t2 = diffSync(t1, current({ me: 2 }), T0 + 10 * 60_000).syncToken; // me refetched at 10 min
  const { changed } = diffSync(t2, current({ me: 2 }), T0 + MAX_AGE_MS);
  assert.equal(changed.me, false);
  assert.equal(changed.mine, true);
});

test('a token timestamp from the future is not trusted', () => {
  const future = encodeToken(Object.fromEntries(KEYS.map((k) => [k, [current()[k], T0 + 3_600_000]])));
  assert.deepEqual(diffSync(future, current(), T0).changed, allTrue);
});

test('unknown keys in a token are ignored; missing ones are reported as changed', () => {
  const partial = encodeToken({ me: [1, T0], bogus: [1, T0] });
  assert.deepEqual(decodeToken(partial), { me: [1, T0] });
  const { changed } = diffSync(partial, current(), T0 + 1000);
  assert.equal(changed.me, false);
  assert.equal(changed.mine, true);
});

test('a missing current value is a programming error, not a silent always-true flag', () => {
  const incomplete = current();
  delete incomplete.weekly;
  assert.throws(() => diffSync(undefined, incomplete, T0), /no current value for 'weekly'/);
});

test('the token stays small', () => {
  const { syncToken } = diffSync(undefined, current(), T0);
  assert.ok(syncToken.length < 600, `token is ${syncToken.length} chars`);
  assert.match(syncToken, /^[A-Za-z0-9_-]+$/); // safe in a query string or header
});

// --- bumpSync / userVersions --------------------------------------------------

let store;
beforeEach(() => {
  store = new Map();
  SyncState.updateOne = async (filter, update, opts = {}) => {
    let doc = store.get(String(filter.user));
    if (!doc) {
      if (!opts.upsert) return { matchedCount: 0 };
      doc = { user: filter.user, v: {} };
      store.set(String(filter.user), doc);
    }
    for (const [path, n] of Object.entries(update.$inc)) {
      const key = path.slice(2);
      doc.v[key] = (doc.v[key] || 0) + n;
    }
    return { matchedCount: 1 };
  };
  SyncState.findOne = (filter) => ({
    select: () => ({ lean: async () => store.get(String(filter.user)) || null }),
  });
});

test('userVersions: a user never bumped reads as all zeros', async () => {
  assert.deepEqual(await userVersions('u1'), Object.fromEntries(USER_KEYS.map((k) => [k, 0])));
});

test('bumpSync increments only the given keys, for that user only', async () => {
  await bumpSync('u1', ['infinite', 'notifications']);
  await bumpSync('u1', 'infinite');
  await bumpSync('u2', 'me');
  const v1 = await userVersions('u1');
  assert.equal(v1.infinite, 2);
  assert.equal(v1.notifications, 1);
  assert.equal(v1.me, 0);
  assert.equal((await userVersions('u2')).me, 1);
});

test('bumpSync ignores keys that are not per-user versions', async () => {
  await bumpSync('u1', ['daily', 'weekly', 'tiers', 'bogus']);
  assert.equal(store.size, 0);
});

test('bumpSync retries without upsert when two first bumps race', async () => {
  const real = SyncState.updateOne;
  let calls = 0;
  SyncState.updateOne = async (filter, update, opts) => {
    calls += 1;
    if (calls === 1) {
      await real(filter, { $inc: {} }, { upsert: true }); // the other request created it
      const err = new Error('dup');
      err.code = 11000;
      throw err;
    }
    return real(filter, update, opts);
  };
  await bumpSync('u1', 'me');
  assert.equal((await userVersions('u1')).me, 1);
});

test('bumpSync never throws, even if the database fails', async () => {
  SyncState.updateOne = async () => {
    throw new Error('db down');
  };
  const origError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await assert.doesNotReject(bumpSync('u1', 'me'));
  } finally {
    console.error = origError;
  }
  assert.match(logged[0], /bumpSync\(u1, me\) failed/);
});

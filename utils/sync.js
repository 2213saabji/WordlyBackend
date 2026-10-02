// Change tracking for GET /api/sync: tells the app, per API, whether its
// data may have changed since the app last fetched it, so unchanged APIs
// aren't called at all.
//
// The server keeps no "already told this device" state. Each sync response
// carries a syncToken that the app sends back next time; the token records,
// per key, the version the app last fetched and when. So it works across
// several devices, and a refetch that fails simply shows up as changed
// again on the next sync.

const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { istDayKey } = require('./dailyWord');
const { getWeekRange } = require('./leaderboard');

// Versions that live on the user's SyncState document (bumped by bumpSync).
const USER_KEYS = ['me', 'today', 'mine', 'infinite', 'tierChanges', 'notifications', 'wallet'];
// Versions shared by everyone, on the single SyncGlobal document (bumpGlobal).
const GLOBAL_KEYS = ['daily', 'weekly', 'infiniteBoard'];
const GLOBAL_ID = 'global';
// /sync reads the global counters through a per-process cache. Leaderboard
// flags are throttled to once a minute anyway, so this adds no visible delay
// and spares the read on most syncs.
const GLOBAL_CACHE_MS = 15 * 1000;

const MINUTE_MS = 60 * 1000;

// Every key /sync reports, with its rules:
//   throttleMs — a change is reported at most once per this interval
//                (leaderboards change on every other player's game).
// Any key the app last fetched more than MAX_AGE_MS ago is reported as
// changed regardless: a safety net for data changed outside the code paths
// that bump versions (manual DB fixes, coin adjustments by hand).
const SYNC_KEYS = {
  me: {},
  mine: {},
  notifications: {},
  infinite: {},
  tierChanges: {},
  wallet: {},
  today: {},
  tiers: {},
  daily: { throttleMs: MINUTE_MS },
  weekly: { throttleMs: MINUTE_MS },
  infiniteBoard: { throttleMs: MINUTE_MS },
};
const MAX_AGE_MS = 15 * MINUTE_MS;
const TOKEN_VERSION = 1;

// Bumps the given counters for a user. Call it AFTER the write it describes
// has completed, so a sync that sees the new version is guaranteed to find
// the new data. Never throws: a missed bump only delays the app's refresh
// until MAX_AGE_MS, which isn't worth failing the player's request over.
async function bumpSync(userId, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => USER_KEYS.includes(k));
  if (!userId || !list.length) return;
  const $inc = Object.fromEntries(list.map((k) => [`v.${k}`, 1]));
  try {
    await SyncState.updateOne({ user: userId }, { $inc }, { upsert: true });
  } catch (err) {
    // Two first-bumps racing on the upsert: the other one created it.
    if (err && err.code === 11000) {
      try {
        await SyncState.updateOne({ user: userId }, { $inc });
        return;
      } catch (retryErr) {
        err = retryErr;
      }
    }
    console.error(`bumpSync(${userId}, ${list.join(',')}) failed:`, err);
  }
}

// bumpSync() for several users at once, in one round trip — e.g. every
// member of a group that changed. Same rules: call after the write, never
// throws.
async function bumpSyncMany(userIds, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => USER_KEYS.includes(k));
  const users = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!users.length || !list.length) return;
  const $inc = Object.fromEntries(list.map((k) => [`v.${k}`, 1]));
  try {
    await SyncState.bulkWrite(
      users.map((user) => ({ updateOne: { filter: { user }, update: { $inc }, upsert: true } })),
      { ordered: false }
    );
  } catch (err) {
    // Upserts racing another first bump for the same user fail with a
    // duplicate key; those users' documents exist now, so retry just them
    // without upsert. The other operations in the batch already applied.
    const dupes = (err && err.writeErrors ? err.writeErrors : [])
      .filter((e) => (e.code ?? (e.err && e.err.code)) === 11000)
      .map((e) => users[e.index]);
    const unexplained = !dupes.length || (err.writeErrors && err.writeErrors.length !== dupes.length);
    if (dupes.length) {
      try {
        await SyncState.bulkWrite(dupes.map((user) => ({ updateOne: { filter: { user }, update: { $inc } } })), { ordered: false });
      } catch (retryErr) {
        console.error(`bumpSyncMany retry (${dupes.length} users, ${list.join(',')}) failed:`, retryErr);
      }
    }
    if (unexplained) console.error(`bumpSyncMany(${users.length} users, ${list.join(',')}) failed:`, err);
  }
}

// The user's current counters, all zero if they've never been bumped.
async function userVersions(userId) {
  const doc = await SyncState.findOne({ user: userId }).select('v').lean();
  return Object.fromEntries(USER_KEYS.map((k) => [k, (doc && doc.v && doc.v[k]) || 0]));
}

let globalCache = null; // { value, loadedAt }

// Bumps shared counters (a leaderboard's content changed). Same rules as
// bumpSync: after the write, never throws.
async function bumpGlobal(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => GLOBAL_KEYS.includes(k));
  if (!list.length) return;
  const $inc = Object.fromEntries(list.map((k) => [`v.${k}`, 1]));
  try {
    await SyncGlobal.updateOne({ _id: GLOBAL_ID }, { $inc }, { upsert: true });
    globalCache = null; // this instance sees its own change straight away
  } catch (err) {
    if (err && err.code === 11000) {
      // First-ever bumps racing on the upsert: the document exists now.
      try {
        await SyncGlobal.updateOne({ _id: GLOBAL_ID }, { $inc });
        globalCache = null;
        return;
      } catch (retryErr) {
        err = retryErr;
      }
    }
    console.error(`bumpGlobal(${list.join(',')}) failed:`, err);
  }
}

// The shared counters, cached per process for GLOBAL_CACHE_MS.
async function globalVersions(now = Date.now()) {
  if (globalCache && now - globalCache.loadedAt < GLOBAL_CACHE_MS) return globalCache.value;
  const doc = await SyncGlobal.findById(GLOBAL_ID).select('v').lean();
  const value = Object.fromEntries(GLOBAL_KEYS.map((k) => [k, (doc && doc.v && doc.v[k]) || 0]));
  globalCache = { value, loadedAt: now };
  return value;
}

function resetGlobalCache() {
  globalCache = null;
}

// Daily mode (today's word, the daily and weekly boards) runs on the UTC
// date; Infinite (tiers, the tier board) on the IST date. See dailyWord.js.
function utcDayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// The value /sync compares for every key in SYNC_KEYS. Counters are
// combined with whatever else changes the API's response without a write:
// the day (a new daily word, the nightly tier reset, a new day's board),
// the week, or the tier config.
//   config — the merged tier config (getTierConfig()), for `tiers`
async function currentSyncValues(userId, config, now = Date.now()) {
  const [u, g] = await Promise.all([userVersions(userId), globalVersions(now)]);
  const utcDay = utcDayKey(now);
  const istDay = istDayKey(new Date(now));
  const configStamp = config.updatedAt ? new Date(config.updatedAt).getTime() : 0;

  return {
    me: u.me,
    mine: u.mine,
    notifications: u.notifications,
    tierChanges: u.tierChanges,
    wallet: u.wallet,
    today: `${utcDay}:${u.today}`,
    infinite: `${istDay}:${u.infinite}`,
    tiers: `${config.version}:${configStamp}`,
    daily: `${utcDay}:${g.daily}`,
    weekly: `${getWeekRange(utcDay).start}:${g.weekly}`,
    infiniteBoard: `${istDay}:${g.infiniteBoard}`,
  };
}

// --- Token ----------------------------------------------------------------
// Payload: { tv, s: { key: [value, fetchedAtMs] } }, base64url JSON. It
// holds only version numbers and timestamps for the caller's own data, so it
// isn't signed: editing it can only make the caller's own app refetch more,
// or show its own data stale.

function encodeToken(state) {
  return Buffer.from(JSON.stringify({ tv: TOKEN_VERSION, s: state })).toString('base64url');
}

// The token's per-key state, or null if it's missing, malformed or from an
// older format (all of which mean "treat everything as changed").
function decodeToken(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!parsed || parsed.tv !== TOKEN_VERSION || typeof parsed.s !== 'object' || parsed.s === null) return null;
    const state = {};
    for (const [key, entry] of Object.entries(parsed.s)) {
      if (!SYNC_KEYS[key] || !Array.isArray(entry) || entry.length !== 2) continue;
      const [value, at] = entry;
      if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(at)) continue;
      state[key] = [value, at];
    }
    return state;
  } catch {
    return null;
  }
}

// Compares the current value of every key with what the token says the app
// has, and returns the flags plus the next token.
//   current — { key: number|string } for every key in SYNC_KEYS
// A key is changed when its value differs (and, for throttled keys, the app
// last fetched it at least throttleMs ago), or when the app last fetched it
// MAX_AGE_MS or more ago. For a changed key the next token records the new
// value and `now`; an unchanged one — including a throttled change not
// reported yet — keeps what the app actually has, so it's reported later.
function diffSync(token, current, now = Date.now()) {
  const prev = decodeToken(token) || {};
  const changed = {};
  const next = {};

  for (const [key, rules] of Object.entries(SYNC_KEYS)) {
    const value = current[key];
    // A missing key would be stored as null and never match again (flagged
    // forever), so treat it as the programming error it is.
    if (typeof value !== 'number' && typeof value !== 'string') {
      throw new Error(`diffSync: no current value for '${key}'`);
    }
    const had = prev[key];
    let isChanged;
    if (!had || had[1] > now) {
      isChanged = true; // first sync, unknown key, or a timestamp from the future
    } else {
      const age = now - had[1];
      const differs = had[0] !== value;
      isChanged = age >= MAX_AGE_MS || (differs && (!rules.throttleMs || age >= rules.throttleMs));
    }
    changed[key] = isChanged;
    next[key] = isChanged ? [value, now] : had;
  }

  return { changed, syncToken: encodeToken(next) };
}

module.exports = {
  USER_KEYS,
  GLOBAL_KEYS,
  SYNC_KEYS,
  MAX_AGE_MS,
  bumpSync,
  bumpSyncMany,
  bumpGlobal,
  userVersions,
  globalVersions,
  resetGlobalCache,
  currentSyncValues,
  encodeToken,
  decodeToken,
  diffSync,
};

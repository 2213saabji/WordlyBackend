const crypto = require('crypto');
const { ANSWERS, INFINITE_ANSWERS } = require('../data/words');

function todayKey() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// --- IST day keys. Infinite mode's day (tiers, active time, qualifying days)
// runs 00:00-23:59 IST; Daily mode keeps the UTC todayKey() above.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function istDayKey(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' + n days (n may be negative). Pure calendar math, no timezone.
function addDaysKey(dateKey, n) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The instant an IST day starts (00:00 IST), as a Date.
function istDayStart(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

// Whole days from a to b (b - a) for two 'YYYY-MM-DD' keys.
function diffDaysKey(a, b) {
  const [ay, am, ad] = String(a).split('-').map(Number);
  const [by, bm, bd] = String(b).split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function isConsecutiveDay(previousDateKey, currentDateKey) {
  if (!previousDateKey) return false;
  const previous = new Date(`${previousDateKey}T00:00:00.000Z`);
  const current = new Date(`${currentDateKey}T00:00:00.000Z`);
  const diffDays = Math.round((current - previous) / (24 * 60 * 60 * 1000));
  return diffDays === 1;
}

// ---------------------------------------------------------------------------
// Fixed origin for the daily cycle. Day 0 is this date; day N is N days later.
// Never change this after launch - it would shift every future daily word.
// ---------------------------------------------------------------------------
const EPOCH_UTC = Date.UTC(2024, 0, 1); // 2024-01-01
const MS_PER_DAY = 86400000;

// Shuffle seed. Change it only if you want to reshuffle the whole 2-year run.
const SHUFFLE_SEED = 0x5eed1e;

function dayIndex(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - EPOCH_UTC) / MS_PER_DAY);
}

// mulberry32: tiny deterministic PRNG. Same seed -> same sequence on every
// machine and every Node version, so no coordination or storage is needed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A fixed pseudo-random ordering of ANSWERS, computed once per process.
let orderCache = null;
function answerOrder() {
  if (orderCache) return orderCache;
  const idx = ANSWERS.map((_, i) => i);
  const rand = mulberry32(SHUFFLE_SEED);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  orderCache = idx;
  return orderCache;
}

/**
 * The daily word for a 'YYYY-MM-DD' (UTC) date key.
 *
 * Walks a fixed shuffled ordering of ANSWERS one step per day, so all 728
 * words are used before any repeats - i.e. no duplicate daily word for
 * 728 days (~2 years), then the same order cycles again.
 *
 * Still fully deterministic and stateless: same date -> same word on any
 * server instance, nothing pre-generated, nothing cached across requests.
 */
function wordForDate(dateKey) {
  const order = answerOrder();
  const n = dayIndex(dateKey);
  const i = ((n % order.length) + order.length) % order.length; // handles pre-epoch dates
  return ANSWERS[order[i]];
}

/**
 * The old date-hash mapping, kept for reference and for replaying historical
 * games recorded before the switch. Not used for new daily words: a hash
 * repeats words well inside the first two years.
 */
function wordForDateLegacy(dateKey, pool = ANSWERS) {
  let hash = 0;
  for (let i = 0; i < dateKey.length; i++) {
    hash = (hash * 31 + dateKey.charCodeAt(i)) >>> 0;
  }
  return pool[hash % pool.length];
}

function seedFromString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// userId is public (it's in leaderboard responses), so a seed derived from it
// alone lets anyone with this file predict a player's next infinite word -
// which matters once Tier 1 pays out. With INFINITE_SEED_SECRET set, the seed
// is an HMAC of the userId instead. Setting it reshuffles every existing
// user's order once; without it, the legacy seed is kept.
function infiniteSeed(key) {
  const secret = process.env.INFINITE_SEED_SECRET;
  if (!secret) return seedFromString(key);
  return crypto.createHmac('sha256', secret).update(key).digest().readUInt32BE(0);
}

// A fixed pseudo-random ordering of INFINITE_ANSWERS, one per user, seeded
// from their id so it's reproducible without persisting anything. Cached in
// memory per process, same pattern as answerOrder() above.
const infiniteOrderCache = new Map();
function infiniteAnswerOrder(userId) {
  const key = String(userId);
  if (infiniteOrderCache.has(key)) return infiniteOrderCache.get(key);
  const idx = INFINITE_ANSWERS.map((_, i) => i);
  const rand = mulberry32(infiniteSeed(key));
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  infiniteOrderCache.set(key, idx);
  return idx;
}

/**
 * The INFINITE word for the Nth round a given user has played (0-indexed).
 *
 * Same idea as wordForDate(): walk a fixed shuffled order one step per
 * round, so a user sees all 1456 words before any repeat, then the same
 * shuffled order cycles again - instead of a plain random pick, which could
 * (and did) repeat within the first few dozen rounds.
 */
function infiniteWordForRound(userId, roundIndex) {
  const order = infiniteAnswerOrder(userId);
  const i = ((roundIndex % order.length) + order.length) % order.length;
  return INFINITE_ANSWERS[order[i]];
}

module.exports = {
  todayKey,
  istDayKey,
  addDaysKey,
  istDayStart,
  diffDaysKey,
  isConsecutiveDay,
  wordForDate,
  wordForDateLegacy,
  infiniteWordForRound,
  dayIndex,
  ANSWERS_LENGTH: ANSWERS.length,
  INFINITE_LENGTH: INFINITE_ANSWERS.length,
};

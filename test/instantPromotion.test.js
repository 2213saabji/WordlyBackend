// Instant promotion: when the day that just qualified completes the tier's
// counter, the player moves up right away (same settle as the nightly reset)
// instead of after midnight. Models are in-memory stubs; no database needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TierMembership = require('../models/TierMembership');
const InfiniteDay = require('../models/InfiniteDay');
const TierChange = require('../models/TierChange');
const Notification = require('../models/Notification');
const Payout = require('../models/Payout');
const Game = require('../models/Game');
const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { DEFAULT_TIER_CONFIG: config, tierDef } = require('../utils/tierConfig');
const { evaluateQualification, scoreFinishedGame } = require('../utils/tiers');
const { istDayKey, addDaysKey } = require('../utils/dailyWord');

const USER = '507f1f77bcf86cd799439011';
const TODAY = istDayKey();
const YESTERDAY = addDaysKey(TODAY, -1);

let member; // the one membership document
let day; // today's InfiniteDay
let notes; // notification types sent
let changes; // TierChange records

const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });

beforeEach(() => {
  notes = [];
  changes = [];
  TierMembership.findOne = () => lean(member);
  TierMembership.findById = () => lean(member);
  TierMembership.countDocuments = async () => 0;
  TierMembership.updateOne = async (filter, update) => {
    for (const [k, v] of Object.entries(update.$inc || {})) member[k] = (member[k] || 0) + v;
    Object.assign(member, update.$set || {});
    return {};
  };
  TierMembership.findOneAndUpdate = (filter, update) => {
    const ok = filter.lastSettledDay === member.lastSettledDay && (filter.score === undefined || filter.score === member.score);
    if (ok) Object.assign(member, update.$set);
    return lean(ok ? member : null);
  };
  InfiniteDay.find = () => ({ select: () => lean(day ? [{ day: day.day, qualified: day.qualified }] : []) });
  InfiniteDay.updateOne = async (filter) => {
    if (day.qualified) return { modifiedCount: 0 };
    day.qualified = true;
    return { modifiedCount: 1 };
  };
  InfiniteDay.findById = () => lean(day);
  InfiniteDay.findOneAndUpdate = (filter, update) => {
    for (const [k, v] of Object.entries(update.$inc || {})) day[k] = (day[k] || 0) + v;
    return lean(day);
  };
  TierChange.create = async (doc) => { changes.push(doc); return doc; };
  Notification.create = async (doc) => { notes.push(doc.type); return doc; };
  Payout.updateOne = async () => ({ upsertedCount: 0 });
  SyncState.updateOne = async () => ({});
  SyncGlobal.updateOne = async () => ({});
});

// A player in `tier` with `stickDays` of the tier's counter done and every
// day up to yesterday settled; today already meets the targets.
function setup(tier, stickDays, over = {}) {
  member = {
    _id: 'm1', user: USER, tier, score: 500, qualifyingDaysInTier: stickDays, scoreReachedAt: new Date(),
    stickDays, window: [], missesInWindow: 0, rewardCycle: 0, completedCycles: [],
    enteredTierDay: addDaysKey(TODAY, -stickDays), lastSettledDay: YESTERDAY, ...over.member,
  };
  const def = tierDef(config, tier);
  day = {
    _id: 'd1', user: USER, day: TODAY, tier, targetMinutes: def.minActiveMinutes, targetGames: def.minGamesCompleted,
    activeMs: (def.minActiveMinutes + 1) * 60000, gamesCompleted: def.minGamesCompleted, qualified: false, ...over.day,
  };
}

test('the word that completes Platinum 29 → 30 promotes to Diamond immediately', async () => {
  setup(2, 29);
  await evaluateQualification(day, config);
  assert.equal(member.tier, 1);
  assert.equal(member.lastSettledDay, TODAY, 'today is settled now; the nightly reset skips it');
  assert.equal(member.stickDays, 0, 'Diamond counter starts fresh');
  assert.equal(member.score, Math.floor((500 + config.scoring.qualifyingDayBonus) * config.carryInPercent / 100));
  assert.deepEqual(changes.map((c) => [c.fromTier, c.toTier, c.reason, c.day]), [[2, 1, 'promotion', TODAY]]);
  assert.ok(changes[0].window.some((w) => w.day === TODAY && w.qualified), 'today is in the old tier window');
});

test('reaching Diamond always sends verification_needed (rewards off by default)', async () => {
  assert.equal(config.rewardsEnabled, false);
  setup(2, 29);
  await evaluateQualification(day, config);
  assert.deepEqual(notes.sort(), ['promotion', 'verification_needed']);
});

test('other tiers promote instantly too, without a verification prompt', async () => {
  setup(5, tierDef(config, 5).daysToStick - 1);
  await evaluateQualification(day, config);
  assert.equal(member.tier, 4);
  assert.deepEqual(notes, ['promotion']);
});

test('a qualifying day that does not complete the counter only qualifies (no settle)', async () => {
  setup(2, 20);
  await evaluateQualification(day, config);
  assert.equal(member.tier, 2);
  assert.equal(member.lastSettledDay, YESTERDAY);
  assert.equal(member.stickDays, 20, 'counted at the nightly reset, as before');
  assert.deepEqual(changes, []);
});

test('no instant promotion when earlier days are still unsettled', async () => {
  setup(2, 29, { member: { lastSettledDay: addDaysKey(TODAY, -3) } });
  await evaluateQualification(day, config);
  assert.equal(member.tier, 2);
  assert.deepEqual(changes, []);
});

test('no instant promotion for a day other than today', async () => {
  setup(2, 29, { day: { day: YESTERDAY } });
  await evaluateQualification(day, config);
  assert.equal(member.tier, 2);
});

test('no instant promotion if the player already moved off the day\'s tier', async () => {
  setup(2, 29, { day: { tier: 3 } });
  await evaluateQualification(day, config);
  assert.equal(member.tier, 2);
});

test('Diamond itself is not affected (its reward cycle still runs nightly)', async () => {
  setup(1, tierDef(config, 1).daysToStick - 1);
  await evaluateQualification(day, config);
  assert.equal(member.tier, 1);
  assert.equal(member.lastSettledDay, YESTERDAY);
  assert.equal(member.rewardCycle, 0);
});

test('a day that was already qualified does nothing more', async () => {
  setup(2, 29, { day: { qualified: true } });
  await evaluateQualification(day, config);
  assert.equal(member.tier, 2);
});

test('the round-ending guess reports the promotion and the new tier\'s score', async () => {
  setup(2, 29, { day: { gamesCompleted: tierDef(config, 2).minGamesCompleted - 1 } }); // one word short
  Game.updateOne = async () => ({ modifiedCount: 1 });
  const game = { _id: 'g1', user: USER, status: 'won', guesses: [{}, {}, {}], completedAt: new Date() };
  const tier = await scoreFinishedGame(game, { config, maxAttempts: 6 });
  assert.deepEqual(tier.promotion, { fromTier: 2, toTier: 1 });
  assert.equal(tier.score, member.score);
  assert.equal(member.tier, 1);
  assert.equal(tier.today.gamesCompleted, tierDef(config, 2).minGamesCompleted);
});

test('a round that does not promote reports promotion: null', async () => {
  setup(2, 10, { day: { gamesCompleted: 3 } });
  Game.updateOne = async () => ({ modifiedCount: 1 });
  const tier = await scoreFinishedGame({ _id: 'g2', user: USER, status: 'lost', guesses: [{}], completedAt: new Date() }, { config, maxAttempts: 6 });
  assert.equal(tier.promotion, null);
});

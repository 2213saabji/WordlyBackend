// Inactivity decay and the demotion penalty (PRD v0.2 §2.4–2.5), run by the
// nightly settle. Models are in-memory stubs, so no database is needed.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const TierMembership = require('../models/TierMembership');
const InfiniteDay = require('../models/InfiniteDay');
const TierChange = require('../models/TierChange');
const Notification = require('../models/Notification');
const SyncState = require('../models/SyncState');
const SyncGlobal = require('../models/SyncGlobal');
const { DEFAULT_TIER_CONFIG, decayFor } = require('../utils/tierConfig');
const { settleMembership } = require('../utils/tiers');
const { stubCoins } = require('./helpers/coinStubs');

const USER = '507f1f77bcf86cd799439011';
// Decay applies from effectiveFrom; these tests settle days after it.
const config = { ...DEFAULT_TIER_CONFIG, decay: { ...DEFAULT_TIER_CONFIG.decay, effectiveFrom: '2026-10-01' } };

let doc; // the membership
let notes; // [type, data]
let changes; // TierChange records
let coins;

const lean = (v) => ({ lean: async () => (v == null ? null : structuredClone(v)) });

beforeEach(() => {
  notes = [];
  changes = [];
  coins = stubCoins();
  Notification.create = async (n) => { notes.push([n.type, n.data]); return n; };
  TierChange.create = async (c) => { changes.push(c); return c; };
  SyncState.updateOne = async () => ({});
  SyncGlobal.updateOne = async () => ({});
  TierMembership.countDocuments = async () => 0;
});

// One member and the days they played: { day: { qualified, gamesCompleted } }.
function setup(over, played = {}) {
  doc = {
    _id: 'm1', user: USER, tier: 4, score: 1240, qualifyingDaysInTier: 3, scoreReachedAt: new Date(),
    stickDays: 0, window: [], missesInWindow: 0, rewardCycle: 0, completedCycles: [], lastDecay: null,
    enteredTierDay: '2026-09-01', lastSettledDay: '2026-10-01', ...over,
  };
  TierMembership.findById = () => lean(doc);
  TierMembership.findOneAndUpdate = (filter, update) => {
    const ok = filter.lastSettledDay === doc.lastSettledDay && (filter.score === undefined || filter.score === doc.score);
    if (ok) {
      for (const [k, n] of Object.entries(update.$inc || {})) doc[k] += n;
      Object.assign(doc, update.$set);
    }
    return lean(ok ? doc : null);
  };
  InfiniteDay.find = () => ({
    select: () => lean(Object.entries(played).map(([day, d]) => ({ day, gamesWon: 0, ...d }))),
  });
  return doc;
}

const decayEvents = () => coins.scoreEvents.filter((e) => e.type === 'decay').map((e) => [e.day, e.points]);

test('decayFor: 5% of the points, at least 10, never below 0', () => {
  assert.equal(decayFor(config, 1240), 62);
  assert.equal(decayFor(config, 100), 10, 'minimum 10');
  assert.equal(decayFor(config, 7), 7, 'never more than what is left');
  assert.equal(decayFor(config, 0), 0);
});

test('a day with no games costs 5% of the tier points', async () => {
  setup({});
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.score, 1240 - 62);
  assert.deepEqual(doc.lastDecay, { day: '2026-10-02', points: -62 });
  assert.deepEqual(decayEvents(), [['2026-10-02', -62]]);
  assert.deepEqual(notes.find(([t]) => t === 'points_decayed'), ['points_decayed', { points: -62, days: 1, day: '2026-10-02', tier: 4 }]);
});

test('a day played but short of the targets is not decayed (only a miss)', async () => {
  setup({}, { '2026-10-02': { qualified: false, gamesCompleted: 2 } });
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.score, 1240);
  assert.equal(doc.missesInWindow, 1);
  assert.deepEqual(decayEvents(), []);
  assert.ok(!notes.some(([t]) => t === 'points_decayed'));
});

test('a qualifying day is not decayed', async () => {
  setup({}, { '2026-10-02': { qualified: true, gamesCompleted: 9 } });
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.score, 1240);
});

test('several idle days compound, with one notification for all of them', async () => {
  setup({ tier: 6, score: 1000, lastSettledDay: '2026-10-01' });
  await settleMembership(doc, config, '2026-10-03');
  // 1000 → 950 (−50) → 903 (−47)
  assert.equal(doc.score, 903);
  assert.deepEqual(decayEvents(), [['2026-10-02', -50], ['2026-10-03', -47]]);
  const decayed = notes.filter(([t]) => t === 'points_decayed');
  assert.deepEqual(decayed, [['points_decayed', { points: -97, days: 2, day: '2026-10-03', tier: 6 }]]);
});

test('points never go below 0', async () => {
  setup({ tier: 8, score: 15 });
  await settleMembership(doc, config, '2026-10-03');
  assert.equal(doc.score, 0); // 15 → 5 → 0
});

test('Tier 8 decays too', async () => {
  setup({ tier: 8, score: 400 });
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.score, 380);
});

test('days before decay.effectiveFrom are never decayed', async () => {
  setup({ tier: 8, lastSettledDay: '2026-09-28' }); // Tier 8: four misses can't demote it
  await settleMembership(doc, config, '2026-10-02');
  // Only 10-01 and 10-02 decay: 1240 → 1178 → 1120.
  assert.deepEqual(decayEvents().map(([d]) => d), ['2026-10-01', '2026-10-02']);
  assert.equal(doc.score, 1120);
});

test('decay rate and minimum are config', async () => {
  setup({ score: 1000 });
  await settleMembership(doc, { ...config, decay: { ...config.decay, rate: 0.1, minPoints: 0 } }, '2026-10-02');
  assert.equal(doc.score, 900);
});

// --- demotion penalty ---------------------------------------------------------

test('PRD example: 900 points in Gold, demoted on a played day → 180 − 50 = 130 in Silver', async () => {
  // Gold's window is its 21 days; two misses already, the third arrives on
  // a day that was played (so no decay that night).
  setup(
    { tier: 3, score: 900, window: [{ day: '2026-09-30', qualified: false }, { day: '2026-10-01', qualified: false }], missesInWindow: 2 },
    { '2026-10-02': { qualified: false, gamesCompleted: 3 } }
  );
  const { stats } = await settleMembership(doc, config, '2026-10-02');
  assert.equal(stats.demoted, 1);
  assert.equal(doc.tier, 4);
  assert.equal(doc.score, 130);
  const c = changes[0];
  assert.deepEqual(
    { oldScore: c.oldScore, carriedPoints: c.carriedPoints, penalty: c.penalty, entryPoints: c.entryPoints, carriedScore: c.carriedScore },
    { oldScore: 900, carriedPoints: 180, penalty: -50, entryPoints: 130, carriedScore: 130 }
  );
  assert.deepEqual(
    coins.scoreEvents.map((e) => [e.type, e.points, e.tier]),
    [['carry_in', 180, 4], ['demotion_penalty', -50, 4]]
  );
  const [, data] = notes.find(([t]) => t === 'demotion');
  assert.equal(data.entryPoints, 130);
});

test('decay runs before the demotion carry-over on an idle night', async () => {
  setup({ tier: 3, score: 900, window: [{ day: '2026-09-30', qualified: false }, { day: '2026-10-01', qualified: false }], missesInWindow: 2 });
  await settleMembership(doc, config, '2026-10-02');
  // 900 − 45 decay = 855 → 20% = 171 → − 50 = 121
  assert.equal(doc.score, 121);
  assert.equal(changes[0].oldScore, 855);
  assert.equal(changes[0].carriedPoints, 171);
  assert.deepEqual(coins.scoreEvents.map((e) => e.type), ['decay', 'carry_in', 'demotion_penalty']);
});

test('the penalty never takes the entry points below 0', async () => {
  setup(
    { tier: 6, score: 100, window: [{ day: '2026-09-30', qualified: false }, { day: '2026-10-01', qualified: false }], missesInWindow: 2 },
    { '2026-10-02': { qualified: false, gamesCompleted: 1 } }
  );
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.score, 0);
  assert.equal(changes[0].carriedPoints, 20);
  assert.equal(changes[0].penalty, -20, 'only what was there');
});

test('promotion has no penalty: plain 20% carry-in', async () => {
  setup({ tier: 5, score: 1450, stickDays: 9 }, { '2026-10-02': { qualified: true, gamesCompleted: 7 } });
  await settleMembership(doc, config, '2026-10-02');
  assert.equal(doc.tier, 4);
  assert.equal(doc.score, 290);
  assert.equal(changes[0].penalty, 0);
  assert.deepEqual(coins.scoreEvents.map((e) => e.type), ['carry_in']);
});

test('the demotion penalty is config', async () => {
  setup(
    { tier: 3, score: 900, window: [{ day: '2026-09-30', qualified: false }, { day: '2026-10-01', qualified: false }], missesInWindow: 2 },
    { '2026-10-02': { qualified: false, gamesCompleted: 3 } }
  );
  await settleMembership(doc, { ...config, demotionPenalty: 0 }, '2026-10-02');
  assert.equal(doc.score, 180);
});

test('the demotion-risk alert mentions the penalty', async () => {
  setup({ tier: 5, window: [{ day: '2026-10-01', qualified: false }], missesInWindow: 1 }, { '2026-10-02': { qualified: false, gamesCompleted: 2 } });
  // Settle "yesterday" so the risk alert is sent.
  const { yesterdayIst } = require('../utils/tiers');
  const day = yesterdayIst();
  doc.lastSettledDay = require('../utils/dailyWord').addDaysKey(day, -1);
  InfiniteDay.find = () => ({ select: () => lean([{ day, qualified: false, gamesCompleted: 2, gamesWon: 0 }]) });
  await settleMembership(doc, config, day);
  const risk = notes.find(([t]) => t === 'demotion_risk');
  assert.ok(risk);
  assert.equal(risk[1].demotionPenalty, 50);
});

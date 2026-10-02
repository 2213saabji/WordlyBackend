const Game = require('../models/Game');
const User = require('../models/User');
const { VALID_GUESS_SET } = require('../data/words');
const { evaluateGuess, isWin } = require('../utils/wordleLogic');
const InfiniteDay = require('../models/InfiniteDay');
const { todayKey, istDayKey, wordForDate, infiniteWordForRound, isConsecutiveDay } = require('../utils/dailyWord');
const { difficultyForDailyWord, difficultyForInfiniteWord } = require('../utils/wordDifficulty');
const { hintForWord } = require('../utils/wordHints');
const { getTierConfig, tierDef } = require('../utils/tierConfig');
const { loadSettledMembership, creditActivity, scoreFinishedGame, todayProgress } = require('../utils/tiers');
const { bumpSync, bumpGlobal } = require('../utils/sync');
const {
  InsufficientCoinsError,
  DuplicateEntryError,
  runInTransaction,
  applyCoins,
  walletChanged,
  getBalance,
  awardSolveCoins,
} = require('../utils/wallet');

const MAX_ATTEMPTS = 6;
const WORD_LENGTH = 5;

// `infinite` options apply to infinite games only:
//   hintCost       - coins the caller's current tier charges for the hint
//                    (0 = free: the hint is in the payload from the start;
//                    null = hints off in this tier)
//   hideDifficulty - withhold difficulty until the game ends (stops players
//                    skipping every hard word before guessing)
function serializeGame(game, infinite = {}) {
  const difficulty = game.mode === 'daily'
    ? difficultyForDailyWord(game.word)
    : difficultyForInfiniteWord(game.word);

  const base = {
    id: game._id,
    mode: game.mode,
    date: game.date,
    status: game.status,
    attemptsUsed: game.guesses.length,
    attemptsRemaining: MAX_ATTEMPTS - game.guesses.length,
    guesses: game.guesses.map((g) => ({ guess: g.guess, result: g.result })),
    // Only reveal the answer once the game is over.
    word: game.status === 'in-progress' ? undefined : game.word,
    difficulty,
    hint: hintForWord(game.word),
    timeTakenMs: game.timeTakenMs,
  };
  if (game.mode !== 'infinite') return base;

  // Infinite: mid-game, the hint is in the payload only when it's free in
  // the player's tier (Tiers 7-8) or they already revealed (bought) it.
  // In Tiers 1-6 it costs coins, through POST /game/infinite/hint.
  const inProgress = game.status === 'in-progress';
  const { hintCost } = infinite;
  const showHint = !inProgress || hintCost === 0 || Boolean(game.hintRevealedAt);
  return {
    ...base,
    hint: showHint ? base.hint : undefined,
    difficulty: inProgress && infinite.hideDifficulty ? undefined : difficulty,
    hintCost,
    // Deprecated: true when the hint is free. Kept so older apps keep
    // hiding the hint in paid tiers instead of calling the hint endpoint.
    hintsEnabled: hintCost === 0,
    hintRevealed: Boolean(game.hintRevealedAt),
    hintCoinsSpent: game.hintCoinsSpent || 0,
    pointsAwarded: game.pointsAwarded ?? null,
    countedDay: game.countedDay ?? null,
    tierAtCompletion: game.tierAtCompletion ?? null,
  };
}

function clientIpOf(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

function deviceIdOf(req) {
  const { deviceId } = req.body || {};
  return typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, 100) : null;
}

// Any word from the combined dictionary is a valid guess in either mode -
// only which pool an answer is drawn from is mode-scoped, not what a player
// may type. See data/words.js.
function validateGuessInput(guess) {
  if (typeof guess !== 'string' || guess.length !== WORD_LENGTH || !/^[a-zA-Z]+$/.test(guess)) {
    return `Guess must be a ${WORD_LENGTH}-letter word`;
  }
  if (!VALID_GUESS_SET.has(guess.toLowerCase())) {
    return 'Not a recognized word';
  }
  return null;
}

async function getOrCreateTodayGame(userId) {
  const date = todayKey();
  let game = await Game.findOne({ user: userId, date, mode: 'daily' });
  if (!game) {
    game = await Game.create({ user: userId, date, word: wordForDate(date), mode: 'daily' });
  }
  return game;
}

async function getToday(req, res) {
  const game = await getOrCreateTodayGame(req.userId);
  return res.json({ game: serializeGame(game) });
}

async function submitGuess(req, res) {
  const { guess } = req.body;

  const validationError = validateGuessInput(guess);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }
  const normalizedGuess = guess.toLowerCase();

  const game = await getOrCreateTodayGame(req.userId);

  if (game.status !== 'in-progress') {
    return res.status(400).json({ message: 'Today\'s game is already finished', game: serializeGame(game) });
  }
  if (game.guesses.length >= MAX_ATTEMPTS) {
    return res.status(400).json({ message: 'No attempts remaining' });
  }

  const result = evaluateGuess(normalizedGuess, game.word);
  game.guesses.push({ guess: normalizedGuess, result });

  const won = isWin(result);
  const outOfAttempts = game.guesses.length >= MAX_ATTEMPTS;

  if (won) {
    game.status = 'won';
  } else if (outOfAttempts) {
    game.status = 'lost';
  }

  if (game.status !== 'in-progress') {
    game.completedAt = new Date();
    game.timeTakenMs = game.completedAt - game.createdAt;
  }

  await game.save();

  const response = { result, game: serializeGame(game) };
  if (game.status !== 'in-progress') {
    await applyStatsForFinishedGame(req.userId, game);
    // +10 coins for a solve; { awarded: 0 } for a loss.
    response.coins = await awardSolveCoins(game, await getTierConfig());
  }
  // Every guess changes /game/today; a finished game also changes the
  // stats in /auth/me and puts the player on the daily and weekly boards.
  if (game.status !== 'in-progress') {
    await Promise.all([bumpSync(req.userId, ['today', 'me']), bumpGlobal(['daily', 'weekly'])]);
  } else {
    await bumpSync(req.userId, 'today');
  }

  return res.json(response);
}

async function applyStatsForFinishedGame(userId, game) {
  const user = await User.findById(userId);
  if (!user) return;

  user.stats.gamesPlayed += 1;

  if (game.status === 'won') {
    user.stats.gamesWon += 1;
    user.stats.currentStreak = isConsecutiveDay(user.stats.lastWinDate, game.date)
      ? user.stats.currentStreak + 1
      : 1;
    user.stats.maxStreak = Math.max(user.stats.maxStreak, user.stats.currentStreak);
    user.stats.lastWinDate = game.date;
  } else {
    user.stats.currentStreak = 0;
  }

  user.stats.lastPlayedDate = game.date;
  await user.save();
}

async function history(req, res) {
  // Read-only response — .lean() skips hydrating full Mongoose documents.
  const games = await Game.find({ user: req.userId, mode: 'daily' }).sort({ date: -1 }).limit(30).lean();
  return res.json({ games: games.map(serializeGame) });
}

// --- Infinite mode: unlimited rounds, random word each time. Never touches
// user.stats (no streaks) and is excluded from the daily/weekly/group
// leaderboards by their mode: 'daily' filters. It feeds only the tier
// leaderboard, through utils/tiers.js.

// Config + the caller's settled membership (null before their first
// completed game, which means Tier 8), and the serializer options that
// follow from their tier.
async function infiniteContext(userId) {
  const config = await getTierConfig();
  const membership = await loadSettledMembership(userId, config);
  const tier = membership ? membership.tier : 8;
  return {
    config,
    membership,
    tier,
    view: { hintCost: tierDef(config, tier).hintCost, hideDifficulty: config.hideDifficultyInProgress },
  };
}

// Returns the round, plus today's InfiniteDay when creating it credited
// activity (null when an existing round was returned).
async function getOrCreateCurrentInfiniteGame(userId, ctx) {
  let game = await Game.findOne({ user: userId, mode: 'infinite', status: 'in-progress' });
  let dayDoc = null;
  if (!game) {
    const roundIndex = await Game.countDocuments({ user: userId, mode: 'infinite' });
    game = await Game.create({
      user: userId,
      date: istDayKey(),
      word: infiniteWordForRound(userId, roundIndex),
      mode: 'infinite',
      tierAtStart: ctx.tier,
    });
    // Starting a round is a game action: it credits the time since the
    // previous one (the result screen, moving to the next word), capped.
    // Only on creation — returning an existing round is a page load, not play.
    ({ dayDoc } = await creditActivity({ userId, tier: ctx.tier, config: ctx.config, source: 'game' }));
  }
  return { game, dayDoc };
}

// Today's progress card for Infinite responses, from a day document already
// in hand or, failing that, one read.
async function infiniteToday(userId, ctx, dayDoc) {
  const today = istDayKey();
  const doc = dayDoc && dayDoc.day === today ? dayDoc : await InfiniteDay.findOne({ user: userId, day: today }).lean();
  return todayProgress(doc, ctx.tier, ctx.config, today);
}

async function getCurrentInfinite(req, res) {
  const ctx = await infiniteContext(req.userId);
  const { game, dayDoc } = await getOrCreateCurrentInfiniteGame(req.userId, ctx);
  return res.json({ game: serializeGame(game, ctx.view), today: await infiniteToday(req.userId, ctx, dayDoc) });
}

// Abandons any in-progress round for this user and starts a fresh one —
// the "new word" / "skip" action. With abandonAfterGuessIsLoss on, a round
// abandoned after at least one guess is scored as a loss (0 points, counts
// as completed), so skipping a word once it looks hard isn't free.
async function newInfiniteGame(req, res) {
  const ctx = await infiniteContext(req.userId);
  const inProgress = await Game.find({ user: req.userId, mode: 'infinite', status: 'in-progress' });

  for (const old of inProgress) {
    old.status = 'abandoned';
    const scoreAsLoss = ctx.config.abandonAfterGuessIsLoss && old.guesses.length > 0;
    if (scoreAsLoss) {
      old.completedAt = new Date();
      old.timeTakenMs = old.completedAt - old.createdAt;
      old.clientIp = clientIpOf(req);
      old.deviceId = deviceIdOf(req);
    }
    await old.save();
    if (scoreAsLoss) {
      await scoreFinishedGame(old, { config: ctx.config, maxAttempts: MAX_ATTEMPTS });
    }
  }

  // Any abandoned round was scored above, so the day document the new
  // round's credit returns is already up to date.
  const { game, dayDoc } = await getOrCreateCurrentInfiniteGame(req.userId, ctx);
  return res.status(201).json({
    game: serializeGame(game, ctx.view),
    today: await infiniteToday(req.userId, ctx, dayDoc),
  });
}

// The body of a successful hint response.
async function hintResponse(game, userId, coinsSpent, balance) {
  return {
    hint: hintForWord(game.word),
    coinsSpent,
    balance: balance ?? (await getBalance(userId)),
    hintsUsed: 1,
    hintsLeft: 0,
  };
}

// POST /game/infinite/hint  { gameId?, expectedCost }
// Reveals the current round's hint (the word's clue). One hint per round;
// asking again returns the same hint at no charge. The cost is the
// caller's tier at request time (so a player promoted overnight into
// Tier 6 pays for a round started in Tier 7):
//   off (hintCost null, for a staged rollout) → 403 HINTS_DISABLED_FOR_TIER;
//   free (Tiers 7–8)  → revealed straight away;
//   paid (Tiers 1–6)  → the app must send expectedCost equal to the cost it
//                       showed on the confirm sheet (none at all = an app
//                       from before paid hints: 403, as before). The coins are debited
//                       and the hint revealed in one transaction: if either
//                       fails, neither happens. expectedCost is only a
//                       guard — the amount charged is always the server's.
async function revealInfiniteHint(req, res) {
  const ctx = await infiniteContext(req.userId);
  const { gameId, expectedCost } = req.body || {};

  const game = await Game.findOne({ user: req.userId, mode: 'infinite', status: 'in-progress' });
  if (!game || (gameId != null && String(game._id) !== String(gameId))) {
    return res.status(400).json({ message: 'No infinite game in progress. Start one with POST /api/game/infinite/new', code: 'NO_GAME_IN_PROGRESS' });
  }
  if (game.hintRevealedAt) {
    return res.json(await hintResponse(game, req.userId, 0));
  }
  const cost = ctx.view.hintCost;
  if (cost === null) {
    return res.status(403).json({ message: 'Hints are off in your tier', code: 'HINTS_DISABLED_FOR_TIER' });
  }
  if (!hintForWord(game.word)) {
    return res.status(409).json({ message: 'This word has no hint', code: 'NOTHING_TO_REVEAL' });
  }

  if (cost === 0) {
    await Game.updateOne({ _id: game._id, hintRevealedAt: null }, { $set: { hintRevealedAt: new Date(), hintCoinsSpent: 0 } });
    return res.json(await hintResponse(game, req.userId, 0));
  }

  const balance = await getBalance(req.userId);
  if (expectedCost === undefined || expectedCost === null) {
    // An app from before paid hints (it never shows a price): answer the
    // way it already handles — hints off — and charge nothing.
    return res.status(403).json({
      message: 'Hints cost coins in your tier. Update the app to buy one.',
      code: 'HINTS_DISABLED_FOR_TIER',
      hintCost: cost,
      balance,
    });
  }
  if (expectedCost !== cost) {
    // The app showed a different price (config or tier changed since the
    // confirm sheet opened). Nothing is charged.
    return res.status(409).json({
      message: `A hint costs ${cost} coins. Confirm to buy it.`,
      code: 'HINT_COST_CHANGED',
      hintCost: cost,
      balance,
    });
  }
  if (balance < cost) {
    return res.status(402).json({ message: 'Not enough coins', code: 'INSUFFICIENT_COINS', balance, required: cost });
  }

  try {
    const entry = await runInTransaction(async (session) => {
      const debit = await applyCoins({
        userId: req.userId,
        type: 'hint_spend',
        amount: -cost,
        idempotencyKey: `hint:${game._id}`,
        ref: { gameId: String(game._id), tier: ctx.tier },
        session,
      });
      const revealed = await Game.updateOne(
        { _id: game._id, status: 'in-progress', hintRevealedAt: null },
        { $set: { hintRevealedAt: new Date(), hintCoinsSpent: cost } },
        { session }
      );
      // The round ended or another request revealed it first: abort, so
      // the debit rolls back.
      if (!revealed.modifiedCount) throw new DuplicateEntryError();
      return debit;
    });
    await walletChanged(req.userId);
    return res.json(await hintResponse(game, req.userId, cost, entry.balanceAfter));
  } catch (err) {
    if (err instanceof InsufficientCoinsError) {
      return res.status(402).json({ message: 'Not enough coins', code: 'INSUFFICIENT_COINS', balance: err.balance, required: cost });
    }
    if (!(err instanceof DuplicateEntryError)) throw err;
    // Nothing was charged by this request. Report what's true now.
    const current = await Game.findById(game._id);
    if (current && current.hintRevealedAt) return res.json(await hintResponse(current, req.userId, 0));
    return res.status(400).json({ message: 'This round is already over', code: 'NO_GAME_IN_PROGRESS' });
  }
}

async function submitInfiniteGuess(req, res) {
  const { guess } = req.body;

  const validationError = validateGuessInput(guess);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }
  const normalizedGuess = guess.toLowerCase();

  // Settle first, so the game is scored against the right tier even if the
  // nightly reset hasn't run yet.
  const ctx = await infiniteContext(req.userId);

  const game = await Game.findOne({ user: req.userId, mode: 'infinite', status: 'in-progress' });
  if (!game) {
    return res.status(400).json({ message: 'No infinite game in progress. Start one with POST /api/game/infinite/new' });
  }
  if (game.guesses.length >= MAX_ATTEMPTS) {
    return res.status(400).json({ message: 'No attempts remaining' });
  }

  const result = evaluateGuess(normalizedGuess, game.word);
  game.guesses.push({ guess: normalizedGuess, result });

  const won = isWin(result);
  const outOfAttempts = game.guesses.length >= MAX_ATTEMPTS;

  if (won) {
    game.status = 'won';
  } else if (outOfAttempts) {
    game.status = 'lost';
  }

  if (game.status !== 'in-progress') {
    game.completedAt = new Date();
    game.timeTakenMs = game.completedAt - game.createdAt;
    game.clientIp = clientIpOf(req);
    game.deviceId = deviceIdOf(req);
  }

  await game.save();

  // A guess is a game action: it credits the time since the previous one.
  const { dayDoc } = await creditActivity({ userId: req.userId, tier: ctx.tier, config: ctx.config, source: 'game' });

  // Deliberately no applyStatsForFinishedGame call — infinite rounds don't
  // affect user.stats or streaks. They score on the tier board instead.
  const response = { result, game: null };
  if (game.status !== 'in-progress') {
    const tier = await scoreFinishedGame(game, { config: ctx.config, maxAttempts: MAX_ATTEMPTS });
    if (tier) response.tier = tier;
    // +10 coins for a solve, once per game (a concurrent request that
    // scored it gets awarded: 0).
    response.coins = await awardSolveCoins(game, ctx.config);
  }
  response.game = serializeGame(game, ctx.view);
  // Every guess returns today's card, so "Active time" updates live. When
  // the round ended, scoring already built it (games completed included);
  // otherwise the credit's day document is current. A round scored by a
  // concurrent request has neither, so read it.
  response.today = response.tier
    ? response.tier.today
    : await infiniteToday(req.userId, ctx, game.status === 'in-progress' ? dayDoc : null);
  return res.json(response);
}

async function infiniteHistory(req, res) {
  const ctx = await infiniteContext(req.userId);
  const games = await Game.find({ user: req.userId, mode: 'infinite' }).sort({ createdAt: -1 }).limit(30).lean();
  return res.json({ games: games.map((g) => serializeGame(g, ctx.view)) });
}

module.exports = {
  getToday,
  submitGuess,
  history,
  getCurrentInfinite,
  newInfiniteGame,
  revealInfiniteHint,
  submitInfiniteGuess,
  infiniteHistory,
};

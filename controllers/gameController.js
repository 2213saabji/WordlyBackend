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

const MAX_ATTEMPTS = 6;
const WORD_LENGTH = 5;

// `infinite` options apply to infinite games only:
//   hintsEnabled   - the caller's current tier allows hints
//   hideDifficulty - withhold difficulty until the game ends (stops players
//                    skipping every hard word before guessing)
function serializeGame(game, infinite = {}) {
  const difficulty = game.mode === 'daily'
    ? difficultyForDailyWord(game.word)
    : difficultyForInfiniteWord(game.word);

  const base = {
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

  // Infinite: mid-game, the hint is in the payload only when the player's
  // tier allows hints (Tiers 7-8) or they already revealed it. Tiers 1-6
  // never receive it until the game is over. POST /game/infinite/hint
  // enforces the same rule for clients that fetch it on demand.
  const inProgress = game.status === 'in-progress';
  const showHint = !inProgress || infinite.hintsEnabled || Boolean(game.hintRevealedAt);
  return {
    ...base,
    hint: showHint ? base.hint : undefined,
    difficulty: inProgress && infinite.hideDifficulty ? undefined : difficulty,
    hintsEnabled: infinite.hintsEnabled,
    hintRevealed: Boolean(game.hintRevealedAt),
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

  if (game.status !== 'in-progress') {
    await applyStatsForFinishedGame(req.userId, game);
  }

  return res.json({ result, game: serializeGame(game) });
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
    view: { hintsEnabled: tierDef(config, tier).hintsEnabled, hideDifficulty: config.hideDifficultyInProgress },
  };
}

async function getOrCreateCurrentInfiniteGame(userId, tier) {
  let game = await Game.findOne({ user: userId, mode: 'infinite', status: 'in-progress' });
  if (!game) {
    const roundIndex = await Game.countDocuments({ user: userId, mode: 'infinite' });
    game = await Game.create({
      user: userId,
      date: istDayKey(),
      word: infiniteWordForRound(userId, roundIndex),
      mode: 'infinite',
      tierAtStart: tier,
    });
  }
  return game;
}

async function getCurrentInfinite(req, res) {
  const ctx = await infiniteContext(req.userId);
  const game = await getOrCreateCurrentInfiniteGame(req.userId, ctx.tier);
  return res.json({ game: serializeGame(game, ctx.view) });
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

  const game = await getOrCreateCurrentInfiniteGame(req.userId, ctx.tier);
  const today = istDayKey();
  const dayDoc = await InfiniteDay.findOne({ user: req.userId, day: today }).lean();
  return res.status(201).json({
    game: serializeGame(game, ctx.view),
    today: todayProgress(dayDoc, ctx.tier, ctx.config, today),
  });
}

// Reveals the hint for the current game. The tier rule is checked here, on
// the server, against the player's tier at request time — so a player
// promoted overnight into Tier 6 can't reveal a hint on a game they started
// in Tier 7. Revealing again returns the same hint.
async function revealInfiniteHint(req, res) {
  const ctx = await infiniteContext(req.userId);
  if (!ctx.view.hintsEnabled) {
    return res.status(403).json({ message: 'Hints are disabled in your tier', code: 'HINTS_DISABLED_FOR_TIER' });
  }

  const game = await Game.findOne({ user: req.userId, mode: 'infinite', status: 'in-progress' });
  if (!game) {
    return res.status(400).json({ message: 'No infinite game in progress. Start one with POST /api/game/infinite/new' });
  }
  if (!game.hintRevealedAt) {
    game.hintRevealedAt = new Date();
    await game.save();
  }
  return res.json({ hint: hintForWord(game.word) });
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

  // A guess is also a heartbeat: it's input, on a visible game.
  await creditActivity({ userId: req.userId, tier: ctx.tier, config: ctx.config, visible: true, lastInputAgoMs: 0 });

  // Deliberately no applyStatsForFinishedGame call — infinite rounds don't
  // affect user.stats or streaks. They score on the tier board instead.
  const response = { result, game: null };
  if (game.status !== 'in-progress') {
    const tier = await scoreFinishedGame(game, { config: ctx.config, maxAttempts: MAX_ATTEMPTS });
    if (tier) response.tier = tier;
  }
  response.game = serializeGame(game, ctx.view);
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

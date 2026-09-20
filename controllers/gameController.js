const Game = require('../models/Game');
const User = require('../models/User');
const { VALID_GUESS_SET } = require('../data/words');
const { evaluateGuess, isWin } = require('../utils/wordleLogic');
const { todayKey, wordForDate, infiniteWordForRound, isConsecutiveDay } = require('../utils/dailyWord');

const MAX_ATTEMPTS = 6;
const WORD_LENGTH = 5;

function serializeGame(game) {
  return {
    mode: game.mode,
    date: game.date,
    status: game.status,
    attemptsUsed: game.guesses.length,
    attemptsRemaining: MAX_ATTEMPTS - game.guesses.length,
    guesses: game.guesses.map((g) => ({ guess: g.guess, result: g.result })),
    // Only reveal the answer once the game is over.
    word: game.status === 'in-progress' ? undefined : game.word,
    timeTakenMs: game.timeTakenMs,
  };
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
  const games = await Game.find({ user: req.userId, mode: 'daily' }).sort({ date: -1 }).limit(30);
  return res.json({ games: games.map(serializeGame) });
}

// --- Infinite mode: unlimited casual rounds, random word each time. Never
// touches user.stats (no streaks) and is excluded from every leaderboard
// query by filtering on mode: 'daily' there — see leaderboardController.js
// and groupController.js.

async function getOrCreateCurrentInfiniteGame(userId) {
  let game = await Game.findOne({ user: userId, mode: 'infinite', status: 'in-progress' });
  if (!game) {
    const roundIndex = await Game.countDocuments({ user: userId, mode: 'infinite' });
    game = await Game.create({
      user: userId,
      date: todayKey(),
      word: infiniteWordForRound(userId, roundIndex),
      mode: 'infinite',
    });
  }
  return game;
}

async function getCurrentInfinite(req, res) {
  const game = await getOrCreateCurrentInfiniteGame(req.userId);
  return res.json({ game: serializeGame(game) });
}

// Abandons any in-progress round for this user and starts a fresh one —
// the "new word" / "skip" action.
async function newInfiniteGame(req, res) {
  await Game.updateMany(
    { user: req.userId, mode: 'infinite', status: 'in-progress' },
    { status: 'abandoned' }
  );
  const game = await getOrCreateCurrentInfiniteGame(req.userId);
  return res.status(201).json({ game: serializeGame(game) });
}

async function submitInfiniteGuess(req, res) {
  const { guess } = req.body;

  const validationError = validateGuessInput(guess);
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }
  const normalizedGuess = guess.toLowerCase();

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
  }

  await game.save();

  // Deliberately no applyStatsForFinishedGame call — infinite rounds don't
  // affect stats, streaks, or any leaderboard.
  return res.json({ result, game: serializeGame(game) });
}

async function infiniteHistory(req, res) {
  const games = await Game.find({ user: req.userId, mode: 'infinite' }).sort({ createdAt: -1 }).limit(30);
  return res.json({ games: games.map(serializeGame) });
}

module.exports = {
  getToday,
  submitGuess,
  history,
  getCurrentInfinite,
  newInfiniteGame,
  submitInfiniteGuess,
  infiniteHistory,
};

function toDateOnlyUTC(dateKey) {
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Monday..Sunday date-key range (inclusive) containing dateKey.
function getWeekRange(dateKey) {
  const date = toDateOnlyUTC(dateKey);
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() + diffToMonday);

  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);

  return { start: formatDateKey(start), end: formatDateKey(end) };
}

// One game per user per day: rank by solved > fewer attempts > faster time.
function rankDailyEntries(games) {
  return games
    // A game can outlive its user (account deleted while their games remain),
    // in which case populate('user') resolves to null - exclude those rather
    // than crashing the whole leaderboard for everyone else.
    .filter((game) => game.user)
    .map((game) => ({
      userId: game.user._id,
      username: game.user.username,
      status: game.status,
      attemptsUsed: game.guesses.length,
      timeTakenMs: game.timeTakenMs,
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'won' ? -1 : 1;
      if (a.attemptsUsed !== b.attemptsUsed) return a.attemptsUsed - b.attemptsUsed;
      return (a.timeTakenMs ?? Infinity) - (b.timeTakenMs ?? Infinity);
    })
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

// Multiple games per user across the week: rank by most wins, then average
// attempts/time on solved games (unsolved games don't have a meaningful
// "attempts to solve", so they're excluded from those averages).
function rankWeeklyEntries(games) {
  const byUser = new Map();

  for (const game of games) {
    if (!game.user) continue; // orphaned reference - user account no longer exists
    const userId = game.user._id.toString();
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId: game.user._id,
        username: game.user.username,
        gamesPlayed: 0,
        gamesWon: 0,
        totalWinAttempts: 0,
        totalWinTimeMs: 0,
      });
    }

    const entry = byUser.get(userId);
    entry.gamesPlayed += 1;
    if (game.status === 'won') {
      entry.gamesWon += 1;
      entry.totalWinAttempts += game.guesses.length;
      entry.totalWinTimeMs += game.timeTakenMs || 0;
    }
  }

  return Array.from(byUser.values())
    .map(({ totalWinAttempts, totalWinTimeMs, ...entry }) => ({
      ...entry,
      avgAttempts: entry.gamesWon ? Number((totalWinAttempts / entry.gamesWon).toFixed(2)) : null,
      avgTimeMs: entry.gamesWon ? Math.round(totalWinTimeMs / entry.gamesWon) : null,
    }))
    .sort((a, b) => {
      if (a.gamesWon !== b.gamesWon) return b.gamesWon - a.gamesWon;
      if (a.avgAttempts !== b.avgAttempts) return (a.avgAttempts ?? Infinity) - (b.avgAttempts ?? Infinity);
      return (a.avgTimeMs ?? Infinity) - (b.avgTimeMs ?? Infinity);
    })
    .map((entry, index) => ({ rank: index + 1, ...entry }));
}

// Slices an already-ranked array into one page. `page` and `limit` are
// assumed pre-validated (see parsePagination in groupController.js).
function paginate(entries, page, limit) {
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * limit;

  return {
    items: entries.slice(start, start + limit),
    pagination: { page: clampedPage, limit, total, totalPages },
  };
}

module.exports = { getWeekRange, rankDailyEntries, rankWeeklyEntries, paginate };

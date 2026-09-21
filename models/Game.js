const mongoose = require('mongoose');

const guessSchema = new mongoose.Schema(
  {
    guess: { type: String, required: true },
    result: { type: [Number], required: true }, // per-letter: 1 | -1 | 0
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const gameSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true }, // 'YYYY-MM-DD' — the daily word key in 'daily' mode, just the day played in 'infinite' mode
    word: { type: String, required: true }, // answer, never sent to the client directly
    guesses: { type: [guessSchema], default: [] },
    // 'daily': one per user per date, feeds stats/streaks and the leaderboards.
    // 'infinite': unlimited casual rounds, random word, never touches stats or leaderboards.
    mode: { type: String, enum: ['daily', 'infinite'], default: 'daily' },
    status: {
      type: String,
      enum: ['in-progress', 'won', 'lost', 'abandoned'], // 'abandoned' is infinite-mode only, set when a round is skipped unfinished
      default: 'in-progress',
    },
    completedAt: { type: Date, default: null },
    timeTakenMs: { type: Number, default: null }, // completedAt - createdAt, set once the game finishes
  },
  { timestamps: true }
);

// Only 'daily' games are limited to one per user per date — 'infinite' games
// share the same (user, date) freely, so the uniqueness is scoped to mode.
gameSchema.index(
  { user: 1, date: 1 },
  { unique: true, partialFilterExpression: { mode: 'daily' } }
);
gameSchema.index({ mode: 1, date: 1, status: 1 }); // leaderboard date/week range queries
gameSchema.index({ user: 1, mode: 1, status: 1 }); // "find my current in-progress infinite game"
gameSchema.index({ user: 1, mode: 1, createdAt: -1 }); // infiniteHistory() sort — {user,mode,status} above doesn't cover the createdAt sort

module.exports = mongoose.model('Game', gameSchema);

const mongoose = require('mongoose');

// Change counters for data shared by every user, behind GET /api/sync: the
// global leaderboards. A single document (_id 'global'), bumped by
// bumpGlobal() in utils/sync.js whenever a board's content changes. /sync
// adds the current day/week to each, so a new day's (empty) board is
// reported even without a bump.
const syncGlobalSchema = new mongoose.Schema(
  {
    _id: { type: String },
    v: {
      daily: { type: Number, default: 0 }, // GET /leaderboard/daily
      weekly: { type: Number, default: 0 }, // GET /leaderboard/weekly
      infiniteBoard: { type: Number, default: 0 }, // GET /leaderboard/infinite
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SyncGlobal', syncGlobalSchema);

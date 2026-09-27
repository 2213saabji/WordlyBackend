const mongoose = require('mongoose');

// Per-user change counters behind GET /api/sync. Each counter is bumped
// (see bumpSync() in utils/sync.js) right after a write that changes what
// the matching API returns for this user, so the app can skip refetching
// APIs whose counter hasn't moved since its last sync. Created on the first
// bump; a user with no document reads as all zeros.
const syncStateSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    v: {
      me: { type: Number, default: 0 }, // GET /auth/me
      today: { type: Number, default: 0 }, // GET /game/today (the player's guesses; /sync adds the IST date)
      mine: { type: Number, default: 0 }, // GET /groups/mine (bumped for every member when a group changes)
      infinite: { type: Number, default: 0 }, // GET /infinite/me
      tierChanges: { type: Number, default: 0 }, // GET /infinite/tier-changes
      notifications: { type: Number, default: 0 }, // GET /notifications
      rewards: { type: Number, default: 0 }, // GET /rewards/me
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SyncState', syncStateSchema);

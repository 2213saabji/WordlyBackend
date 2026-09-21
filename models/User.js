const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },

    resetPasswordTokenHash: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },

    stats: {
      gamesPlayed: { type: Number, default: 0 },
      gamesWon: { type: Number, default: 0 },
      currentStreak: { type: Number, default: 0 },
      maxStreak: { type: Number, default: 0 },
      lastPlayedDate: { type: String, default: null }, // 'YYYY-MM-DD', last completed game
      lastWinDate: { type: String, default: null }, // 'YYYY-MM-DD', for streak continuity
    },

    groups: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Group' }],
  },
  { timestamps: true }
);

// resetPassword() queries on both fields together; every unrequested account
// sits at the default null, so the index buckets those together and still
// makes the actual token lookup an O(log n) point query instead of a scan.
userSchema.index({ resetPasswordTokenHash: 1, resetPasswordExpires: 1 });

module.exports = mongoose.model('User', userSchema);

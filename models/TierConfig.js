const mongoose = require('mongoose');

// Versioned tier thresholds, so they can be tuned without a release. The
// highest `version` wins; fields it leaves out fall back to the defaults in
// utils/tierConfig.js. Loose schema on purpose — the shape is validated
// where it's read, not here.
const tierConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true },
  },
  { strict: false, timestamps: true }
);

module.exports = mongoose.model('TierConfig', tierConfigSchema);

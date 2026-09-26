const mongoose = require('mongoose');

const NOTIFICATION_TYPES = [
  'promotion',
  'demotion_risk',
  'demotion',
  'reward_earned',
  'payout_sent',
  'payout_failed',
  'verification_needed',
];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;

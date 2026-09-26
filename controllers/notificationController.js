const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { parsePagination } = require('../utils/leaderboard');

// GET /notifications?unread=true&page=1
async function list(req, res) {
  const { page, limit } = parsePagination(req.query);
  const filter = { user: req.userId };
  if (req.query.unread === 'true') filter.readAt = null;

  const [total, unreadCount, items] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.userId, readAt: null }),
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);

  return res.json({
    notifications: items.map((n) => ({
      id: n._id,
      type: n.type,
      data: n.data,
      read: Boolean(n.readAt),
      createdAt: n.createdAt,
    })),
    unreadCount,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  });
}

// POST /notifications/read  { ids: [...] }
async function markRead(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return res.status(400).json({ message: 'ids must be a non-empty array of at most 100 notification ids' });
  }
  const validIds = ids.filter((id) => typeof id === 'string' && mongoose.isValidObjectId(id));
  if (validIds.length !== ids.length) {
    return res.status(400).json({ message: 'ids contains an invalid notification id' });
  }

  // Scoped to the caller, so one user can't mark another's notifications read.
  const result = await Notification.updateMany(
    { _id: { $in: validIds }, user: req.userId, readAt: null },
    { $set: { readAt: new Date() } }
  );
  return res.json({ updated: result.modifiedCount });
}

module.exports = { list, markRead };

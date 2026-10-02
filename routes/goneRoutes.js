// Endpoints removed in v0.2 (WhatsApp mobile verification, bank
// verification, the ₹100 Diamond reward and payouts). They answer 410 Gone
// for one release so older apps get a clear answer, then this file and its
// mount in server.js are deleted. (GET /rewards/me is the exception: see
// legacyRewardsMe in controllers/infiniteController.js.)
function gone(req, res) {
  res.status(410).json({ message: 'This feature has been removed', code: 'GONE' });
}

module.exports = { gone };

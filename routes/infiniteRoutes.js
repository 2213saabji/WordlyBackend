const express = require('express');
const router = express.Router();

const { requireAuth, optionalAuth } = require('../middleware/auth');
const { tiers, me, heartbeat, tierChanges } = require('../controllers/infiniteController');

// Public: the tier table is the same for everyone.
router.get('/tiers', optionalAuth, tiers);

router.use(requireAuth);

router.get('/me', me);
router.post('/activity/heartbeat', heartbeat);
router.get('/tier-changes', tierChanges);

module.exports = router;

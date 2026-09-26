const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { tiers, me, heartbeat, tierChanges } = require('../controllers/infiniteController');

router.use(requireAuth);

router.get('/tiers', tiers);
router.get('/me', me);
router.post('/activity/heartbeat', heartbeat);
router.get('/tier-changes', tierChanges);

module.exports = router;

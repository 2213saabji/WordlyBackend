const express = require('express');
const router = express.Router();

const { requireAuth, optionalAuth } = require('../middleware/auth');
const { daily, weekly, infinite } = require('../controllers/leaderboardController');

// Public tier board; signed-in callers also get their pinned "me" row.
router.get('/infinite', optionalAuth, infinite);

router.use(requireAuth);

router.get('/daily', daily);
router.get('/weekly', weekly);

module.exports = router;

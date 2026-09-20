const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { daily, weekly } = require('../controllers/leaderboardController');

router.use(requireAuth);

router.get('/daily', daily);
router.get('/weekly', weekly);

module.exports = router;

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { rewardsMe } = require('../controllers/infiniteController');

router.use(requireAuth);

router.get('/me', rewardsMe);

module.exports = router;

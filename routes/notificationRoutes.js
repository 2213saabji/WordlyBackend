const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { list, markRead } = require('../controllers/notificationController');

router.use(requireAuth);

router.get('/', list);
router.post('/read', markRead);

module.exports = router;

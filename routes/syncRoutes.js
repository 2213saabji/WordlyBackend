const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { sync } = require('../controllers/syncController');

router.get('/', requireAuth, sync);

module.exports = router;

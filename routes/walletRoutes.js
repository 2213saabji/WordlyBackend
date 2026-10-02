const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { wallet, transactions } = require('../controllers/walletController');

router.use(requireAuth);

router.get('/', wallet);
router.get('/transactions', transactions);

module.exports = router;

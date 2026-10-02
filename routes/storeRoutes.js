const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { coinPacks, createOrder, getOrder, confirmOrder } = require('../controllers/storeController');

router.use(requireAuth);

router.get('/coin-packs', coinPacks);
router.post('/orders', createOrder);
router.get('/orders/:orderId', getOrder);
router.post('/orders/:orderId/confirm', confirmOrder);

module.exports = router;

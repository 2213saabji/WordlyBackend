const express = require('express');
const router = express.Router();

const { receivePaymentWebhook } = require('../controllers/paymentWebhookController');

// Mounted at /webhooks, before express.json() in server.js: the gateway
// signature is checked against the raw body, so it's kept as a Buffer here.
router.post('/payments', express.raw({ type: '*/*', limit: '1mb' }), receivePaymentWebhook);

module.exports = router;

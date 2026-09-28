const express = require('express');
const router = express.Router();

const { verifyWebhook, receiveWebhook } = require('../controllers/whatsappWebhookController');

// Mounted at /webhooks, before express.json() in server.js: the WhatsApp
// signature is checked against the raw body, so it's kept as a Buffer here.
router.get('/whatsapp', verifyWebhook);
router.post('/whatsapp', express.raw({ type: '*/*', limit: '1mb' }), receiveWebhook);

module.exports = router;

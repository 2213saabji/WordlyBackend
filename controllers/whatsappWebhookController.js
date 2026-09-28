const Verification = require('../models/Verification');
const { connectDB } = require('../utils/db');
const { tokensMatch, isValidSignature, statusEvents } = require('../utils/whatsapp');

// GET /webhooks/whatsapp — Meta's one-time subscription handshake, when the
// webhook URL is saved in the app dashboard. Meta sends hub.mode=subscribe,
// hub.verify_token (what was typed into the dashboard) and hub.challenge;
// echoing the challenge back as plain text confirms the endpoint.
function verifyWebhook(req, res) {
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!expected) {
    console.error('WhatsApp webhook: WHATSAPP_VERIFY_TOKEN is not set');
    return res.sendStatus(503);
  }
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tokensMatch(token, expected) && typeof challenge === 'string') {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
}

// POST /webhooks/whatsapp — event notifications. `req.body` is the raw
// Buffer (see routes/webhookRoutes.js): the signature covers the exact bytes.
// Only message statuses for OTPs are used: they record whether the code was
// delivered, read, or failed (e.g. the number isn't on WhatsApp).
async function receiveWebhook(req, res) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    // Acknowledge so Meta doesn't keep retrying, but don't trust unsigned data.
    console.error('WhatsApp webhook: WHATSAPP_APP_SECRET is not set; ignoring the event');
    return res.sendStatus(200);
  }
  if (!isValidSignature(req.body, req.get('x-hub-signature-256'), appSecret)) {
    return res.sendStatus(401);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  const events = statusEvents(payload);
  if (events.length) {
    await connectDB();
    // Webhooks can arrive out of order (read before delivered); only move a
    // code's status forward. A failure outranks everything.
    await Promise.all(events.map((e) => Verification.updateOne(
      {
        'mobile.otpMessageId': e.messageId,
        $or: [{ 'mobile.otpDelivery': null }, { 'mobile.otpDelivery.rank': { $lt: e.rank } }],
      },
      { $set: { 'mobile.otpDelivery': { status: e.status, rank: e.rank, at: e.at, errorCode: e.errorCode, errorTitle: e.errorTitle } } }
    )));
    for (const e of events) {
      if (e.status === 'failed') console.error(`WhatsApp OTP ${e.messageId} failed: ${e.errorCode} ${e.errorTitle || ''}`);
    }
  }
  // Meta retries anything that isn't a 200, so acknowledge every valid event,
  // including ones we don't use (incoming messages, other fields).
  return res.sendStatus(200);
}

module.exports = { verifyWebhook, receiveWebhook };

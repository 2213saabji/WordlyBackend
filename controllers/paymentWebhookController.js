const CoinOrder = require('../models/CoinOrder');
const { connectDB } = require('../utils/db');
const { verifyWebhookSignature, parseWebhookEvent, PaymentsNotConfiguredError } = require('../utils/payments');
const { creditOrder, failOrder } = require('../utils/store');

// POST /webhooks/payments — gateway → server, no session. `req.body` is the
// raw Buffer (see routes/webhookRoutes.js): the signature covers the exact
// bytes. payment.captured / order.paid credit the order (the same single
// credit as the confirm call, so whichever arrives first wins);
// payment.failed marks it failed. The gateway retries anything that isn't
// a 2xx, so a valid event we don't use is still acknowledged.
async function receivePaymentWebhook(req, res) {
  let valid;
  try {
    valid = verifyWebhookSignature(req.body, req.get('x-razorpay-signature'));
  } catch (err) {
    if (!(err instanceof PaymentsNotConfiguredError)) throw err;
    console.error('Payment webhook:', err.message);
    return res.sendStatus(503);
  }
  if (!valid) return res.sendStatus(401);

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  const event = parseWebhookEvent(payload);
  if (!event) return res.sendStatus(200);

  await connectDB();
  const order = await CoinOrder.findOne({ gatewayOrderId: event.gatewayOrderId }).lean();
  if (!order) {
    console.error(`Payment webhook: no order for gateway order ${event.gatewayOrderId}`);
    return res.sendStatus(200);
  }

  if (event.kind === 'captured') {
    if (event.amountPaise !== order.amountPaise) {
      // Never credit on a mismatch; leave it for a person to look at.
      console.error(`Payment webhook: ${order.orderId} paid ${event.amountPaise}, expected ${order.amountPaise}`);
      return res.sendStatus(200);
    }
    await creditOrder(order, { gatewayPaymentId: event.gatewayPaymentId, by: 'webhook' });
  } else if (event.kind === 'failed' && order.status !== 'credited' && order.status !== 'paid') {
    await failOrder(order, event.failureReason);
  }
  return res.sendStatus(200);
}

module.exports = { receivePaymentWebhook };

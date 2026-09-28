// WhatsApp OTPs: the Cloud API request, webhook signature and handshake,
// delivery statuses, and POST /verification/mobile/otp choosing WhatsApp.
// fetch and the models are stubbed: nothing reaches Meta or a database.
process.env.VERIFICATION_SECRET = process.env.VERIFICATION_SECRET || 'x'.repeat(40);
// Pretend the DB is connected, for connectDB() in the webhook handler.
globalThis.__mongooseConn = { conn: {}, promise: Promise.resolve({}) };

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

const Verification = require('../models/Verification');
const ReviewCase = require('../models/ReviewCase');
const User = require('../models/User');
const SyncState = require('../models/SyncState');
const wa = require('../utils/whatsapp');
const { serializeStatus } = require('../utils/verification');
const { sendMobileOtp } = require('../controllers/verificationController');

const USER = '507f1f77bcf86cd799439011';
const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const WA_ENV = {
  WHATSAPP_ACCESS_TOKEN: 'EAAtoken',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_OTP_TEMPLATE: 'guessword_otp',
  WHATSAPP_OTP_TEMPLATE_LANG: 'en',
};
const ALL_ENV_KEYS = [...Object.keys(WA_ENV), 'WHATSAPP_OTP_COPY_BUTTON', 'WHATSAPP_OTP_BODY_PARAMS', 'WHATSAPP_API_VERSION', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'SMS_PROVIDER'];

const realFetch = global.fetch;
let fetchCalls;
let fetchReply;

beforeEach(() => {
  for (const k of ALL_ENV_KEYS) delete process.env[k];
  fetchCalls = [];
  fetchReply = { status: 200, body: { messages: [{ id: 'wamid.ABC' }] } };
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      fetchCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
      if (fetchReply instanceof Error) throw fetchReply;
      return new Response(JSON.stringify(fetchReply.body), { status: fetchReply.status });
    }
    return realFetch(url, init);
  };
});
after(() => { global.fetch = realFetch; });

// --- sending ---------------------------------------------------------------------

test('isWhatsAppConfigured needs the token, the phone number id and the template', () => {
  assert.equal(wa.isWhatsAppConfigured(), false);
  Object.assign(process.env, WA_ENV);
  assert.equal(wa.isWhatsAppConfigured(), true);
  delete process.env.WHATSAPP_OTP_TEMPLATE;
  assert.equal(wa.isWhatsAppConfigured(), false);
});

test('sendOtpWhatsApp sends the authentication template with the code (body + copy button)', async () => {
  Object.assign(process.env, WA_ENV);
  const { messageId } = await wa.sendOtpWhatsApp('+919876543210', '048213');
  assert.equal(messageId, 'wamid.ABC');
  const [call] = fetchCalls;
  assert.equal(call.url, 'https://graph.facebook.com/v23.0/1234567890/messages');
  assert.equal(call.init.headers.Authorization, 'Bearer EAAtoken');
  assert.deepEqual(call.body, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '919876543210',
    type: 'template',
    template: {
      name: 'guessword_otp',
      language: { code: 'en' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '048213' }] },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '048213' }] },
      ],
    },
  });
});

test('WHATSAPP_OTP_COPY_BUTTON=false leaves the button out; the API version is configurable', async () => {
  Object.assign(process.env, WA_ENV, { WHATSAPP_OTP_COPY_BUTTON: 'false', WHATSAPP_API_VERSION: 'v24.0' });
  await wa.sendOtpWhatsApp('+14155550123', '111111');
  assert.match(fetchCalls[0].url, /\/v24\.0\//);
  assert.deepEqual(fetchCalls[0].body.template.components.map((c) => c.type), ['body']);
});

test('WHATSAPP_OTP_BODY_PARAMS fills a multi-parameter template (e.g. the demo order template)', async () => {
  Object.assign(process.env, WA_ENV, {
    WHATSAPP_OTP_TEMPLATE: 'jaspers_market_order_confirmation_v1',
    WHATSAPP_OTP_TEMPLATE_LANG: 'en_US',
    WHATSAPP_OTP_COPY_BUTTON: 'false',
    WHATSAPP_OTP_BODY_PARAMS: '["{name}","{code}","{date}"]',
  });
  await wa.sendOtpWhatsApp('+917814692265', '481263', { name: 'Guri' });
  const { template } = fetchCalls[0].body;
  assert.equal(template.name, 'jaspers_market_order_confirmation_v1');
  assert.deepEqual(template.language, { code: 'en_US' });
  assert.equal(template.components.length, 1);
  const [name, code, date] = template.components[0].parameters.map((p) => p.text);
  assert.equal(name, 'Guri');
  assert.equal(code, '481263');
  assert.match(date, /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/); // e.g. "Sep 29, 2026"
});

test('a malformed WHATSAPP_OTP_BODY_PARAMS falls back to just the code; no name reads "there"', async () => {
  Object.assign(process.env, WA_ENV, { WHATSAPP_OTP_BODY_PARAMS: 'not json' });
  const orig = console.error;
  console.error = () => {};
  try { await wa.sendOtpWhatsApp('+919876543210', '123456'); } finally { console.error = orig; }
  assert.deepEqual(fetchCalls[0].body.template.components[0].parameters, [{ type: 'text', text: '123456' }]);

  process.env.WHATSAPP_OTP_BODY_PARAMS = '["Hi {name}", "{code}"]';
  await wa.sendOtpWhatsApp('+919876543210', '123456');
  assert.equal(fetchCalls[1].body.template.components[0].parameters[0].text, 'Hi there');
});

test('a Meta error becomes WhatsAppSendError with its code', async () => {
  Object.assign(process.env, WA_ENV);
  fetchReply = { status: 400, body: { error: { message: 'Recipient phone number not in allowed list', code: 131030 } } };
  await assert.rejects(wa.sendOtpWhatsApp('+919876543210', '123456'), (err) => {
    assert.ok(err instanceof wa.WhatsAppSendError);
    assert.equal(err.code, 131030);
    assert.equal(err.httpStatus, 400);
    return true;
  });
});

test('a network failure becomes WhatsAppSendError too', async () => {
  Object.assign(process.env, WA_ENV);
  fetchReply = new TypeError('fetch failed');
  await assert.rejects(wa.sendOtpWhatsApp('+919876543210', '123456'), wa.WhatsAppSendError);
});

// --- webhook helpers --------------------------------------------------------------

const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

test('isValidSignature: accepts Meta\'s signature, rejects tampering, a wrong secret or a bad header', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}');
  assert.equal(wa.isValidSignature(raw, sign(raw), APP_SECRET), true);
  assert.equal(wa.isValidSignature(Buffer.from('{"object":"x"}'), sign(raw), APP_SECRET), false);
  assert.equal(wa.isValidSignature(raw, sign(raw, 'other'), APP_SECRET), false);
  for (const bad of [undefined, '', 'sha1=abc', 'sha256=zz', `sha256=${'a'.repeat(10)}`]) {
    assert.equal(wa.isValidSignature(raw, bad, APP_SECRET), false, String(bad));
  }
  assert.equal(wa.isValidSignature(raw, sign(raw), ''), false, 'no secret configured');
});

const statusPayload = (statuses) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses } }] }],
});

test('statusEvents flattens message statuses and ignores everything else', () => {
  const events = wa.statusEvents({
    ...statusPayload([
      { id: 'wamid.1', status: 'delivered', timestamp: '1790000000', recipient_id: '919876543210' },
      { id: 'wamid.2', status: 'failed', timestamp: '1790000001', errors: [{ code: 131026, title: 'Message undeliverable' }] },
      { id: 'wamid.3', status: 'weird' },
    ]),
  });
  assert.deepEqual(events.map((e) => [e.messageId, e.status, e.rank, e.errorCode]), [
    ['wamid.1', 'delivered', 2, null],
    ['wamid.2', 'failed', 4, 131026],
  ]);
  assert.equal(events[0].at.getTime(), 1790000000 * 1000);
  assert.deepEqual(wa.statusEvents({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '91…' }] } }] }] }), []);
  assert.deepEqual(wa.statusEvents(null), []);
});

// --- webhook over HTTP --------------------------------------------------------------

let server;
let baseUrl;
let updates;

before(async () => {
  const app = express();
  app.use('/webhooks', require('../routes/webhookRoutes')); // before express.json, as in server.js
  app.use(express.json());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  updates = [];
  Verification.updateOne = async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; };
});

const handshake = (params) => realFetch(`${baseUrl}/webhooks/whatsapp?${new URLSearchParams(params)}`);

test('GET handshake: the right verify token gets the challenge back as plain text', async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  const res = await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), '1158201444');
});

test('GET handshake: a wrong token or mode is 403; no token configured is 503', async () => {
  process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
  assert.equal((await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' })).status, 403);
  assert.equal((await handshake({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' })).status, 403);
  delete process.env.WHATSAPP_VERIFY_TOKEN;
  assert.equal((await handshake({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' })).status, 503);
});

function postEvent(payload, { signature, raw } = {}) {
  const body = raw || Buffer.from(JSON.stringify(payload));
  return realFetch(`${baseUrl}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(signature !== null ? { 'X-Hub-Signature-256': signature || sign(body) } : {}) },
    body,
  });
}

test('POST: a signed status event records the delivery, only moving forward', async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  const res = await postEvent(statusPayload([{ id: 'wamid.ABC', status: 'read', timestamp: '1790000000' }]));
  assert.equal(res.status, 200);
  assert.equal(updates.length, 1);
  const [{ filter, update }] = updates;
  assert.equal(filter['mobile.otpMessageId'], 'wamid.ABC');
  assert.deepEqual(filter.$or, [{ 'mobile.otpDelivery': null }, { 'mobile.otpDelivery.rank': { $lt: 3 } }]);
  assert.equal(update.$set['mobile.otpDelivery'].status, 'read');
});

test('POST: a bad or missing signature is 401 and changes nothing', async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  const payload = statusPayload([{ id: 'wamid.ABC', status: 'read' }]);
  assert.equal((await postEvent(payload, { signature: sign(Buffer.from('other')) })).status, 401);
  assert.equal((await postEvent(payload, { signature: null })).status, 401);
  assert.equal(updates.length, 0);
});

test('POST: with no app secret configured, events are acknowledged but ignored', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await postEvent(statusPayload([{ id: 'wamid.ABC', status: 'read' }]));
    assert.equal(res.status, 200);
  } finally {
    console.error = orig;
  }
  assert.equal(updates.length, 0);
});

test('POST: events without statuses (e.g. an incoming message) get 200 and no update', async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  const res = await postEvent({ entry: [{ changes: [{ field: 'messages', value: { messages: [{ from: '919876543210', text: { body: 'hi' } }] } }] }] });
  assert.equal(res.status, 200);
  assert.equal(updates.length, 0);
});

test('POST: a signed body that is not JSON is 400', async () => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  assert.equal((await postEvent(null, { raw: Buffer.from('not json') })).status, 400);
});

// --- POST /verification/mobile/otp ----------------------------------------------------

let saved;
function stubVerification() {
  saved = null;
  const doc = {
    user: USER,
    mobile: { status: 'not_started', otpSentAt: [] },
    email: { status: 'not_started' },
    bank: { status: 'not_started' },
    save: async function save() { saved = structuredClone({ mobile: this.mobile }); return this; },
  };
  Verification.findOneAndUpdate = () => ({ catch: async () => doc });
  ReviewCase.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  User.findById = () => ({ select: () => ({ lean: async () => ({ username: 'Guri' }) }) });
  SyncState.updateOne = async () => ({});
  return doc;
}

function callOtp(phone) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    Promise.resolve(sendMobileOtp({ body: { phone }, userId: USER }, res)).catch(reject);
  });
}

test('OTP: with WhatsApp configured the code goes by WhatsApp and its message id is kept', async () => {
  Object.assign(process.env, WA_ENV);
  stubVerification();
  const { status, body } = await callOtp('+91 98765 43210');
  assert.equal(status, 200);
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].body.template.components[0].parameters[0].text, /^\d{6}$/);
  assert.equal(saved.mobile.otpChannel, 'whatsapp');
  assert.equal(saved.mobile.otpMessageId, 'wamid.ABC');
  assert.equal(saved.mobile.otpDelivery.status, 'accepted');
  assert.equal(body.mobile.channel, 'whatsapp');
  assert.deepEqual(body.mobile.delivery, { status: 'accepted' });
  assert.equal(body.expiresInSeconds, 600);
});

test('OTP: a number outside the dev test list gets WHATSAPP_RECIPIENT_NOT_ALLOWED and nothing is stored', async () => {
  Object.assign(process.env, WA_ENV);
  stubVerification();
  fetchReply = { status: 400, body: { error: { message: 'not in allowed list', code: 131030 } } };
  const orig = console.error;
  console.error = () => {};
  let res;
  try { res = await callOtp('+919876543210'); } finally { console.error = orig; }
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'WHATSAPP_RECIPIENT_NOT_ALLOWED');
  assert.equal(saved, null);
});

test('OTP: any other WhatsApp failure is OTP_SEND_FAILED', async () => {
  Object.assign(process.env, WA_ENV);
  stubVerification();
  fetchReply = { status: 500, body: { error: { message: 'boom', code: 1 } } };
  const orig = console.error;
  console.error = () => {};
  let res;
  try { res = await callOtp('+919876543210'); } finally { console.error = orig; }
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'OTP_SEND_FAILED');
});

test('OTP: without WhatsApp it falls back to SMS (console in dev), and to 503 with neither', async () => {
  stubVerification();
  const origLog = console.log;
  console.log = () => {};
  try {
    process.env.SMS_PROVIDER = 'console';
    const sms = await callOtp('+919876543210');
    assert.equal(sms.status, 200);
    assert.equal(sms.body.mobile.channel, 'sms');
    assert.equal(sms.body.mobile.delivery, undefined);
    assert.equal(fetchCalls.length, 0);
  } finally {
    console.log = origLog;
  }
  delete process.env.SMS_PROVIDER;
  stubVerification();
  const none = await callOtp('+919876543210');
  assert.equal(none.status, 503);
  assert.equal(none.body.code, 'SMS_PROVIDER_NOT_CONFIGURED');
});

test('status view: a failed WhatsApp delivery with 131026 reads as not_on_whatsapp', async () => {
  ReviewCase.findOne = () => ({ sort: () => ({ lean: async () => null }) });
  const v = {
    user: USER,
    mobile: { status: 'pending', otpMasked: '+••••••••3210', otpChannel: 'whatsapp', otpDelivery: { status: 'failed', rank: 4, errorCode: 131026 } },
    email: { status: 'not_started' },
    bank: { status: 'not_started' },
  };
  const { mobile } = await serializeStatus(v);
  assert.deepEqual(mobile, { status: 'pending', masked: '+••••••••3210', channel: 'whatsapp', delivery: { status: 'failed', reason: 'not_on_whatsapp' } });
  v.mobile.status = 'verified';
  v.mobile.masked = '+••••••••3210';
  assert.deepEqual((await serializeStatus(v)).mobile, { status: 'verified', masked: '+••••••••3210' }, 'no delivery info once verified');
});

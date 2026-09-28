// WhatsApp Cloud API (Meta) for mobile-verification OTPs: sending the code
// as an authentication template, and the webhook helpers (signature check,
// delivery statuses). Configured entirely by env:
//
//   WHATSAPP_ACCESS_TOKEN      permanent System User token with whatsapp_business_messaging
//   WHATSAPP_PHONE_NUMBER_ID   the sending number's id (not the phone number itself)
//   WHATSAPP_OTP_TEMPLATE      name of the approved Authentication-category template
//   WHATSAPP_OTP_TEMPLATE_LANG template language code (default 'en')
//   WHATSAPP_OTP_COPY_BUTTON   'false' if the template has no copy-code / one-tap button
//   WHATSAPP_OTP_BODY_PARAMS   JSON array filling the template body's {{1}}, {{2}}, …
//                              from {code}, {name} (username) and {date}; default ["{code}"],
//                              which is what an Authentication template takes
//   WHATSAPP_API_VERSION       Graph API version (default below)
//   WHATSAPP_VERIFY_TOKEN      shared secret for the webhook's GET handshake
//   WHATSAPP_APP_SECRET        the Meta app's secret, to verify webhook POST signatures
//
// Sending needs the first three; until they're set, isWhatsAppConfigured()
// is false and OTPs fall back to SMS (see utils/otpDelivery.js).

const crypto = require('crypto');

const DEFAULT_API_VERSION = 'v23.0';
const SEND_TIMEOUT_MS = 10000;

class WhatsAppSendError extends Error {
  constructor(message, { httpStatus = null, code = null, subcode = null } = {}) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code; // Meta error code, e.g. 131030 (recipient not in the allowed list)
    this.subcode = subcode;
  }
}

// Meta error codes the app can act on.
const ERROR = {
  RECIPIENT_NOT_ALLOWED: 131030, // development mode: number isn't in the app's test recipient list
  UNDELIVERABLE: 131026, // usually: the number doesn't have WhatsApp
};

function isWhatsAppConfigured() {
  const e = process.env;
  return Boolean(e.WHATSAPP_ACCESS_TOKEN && e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_OTP_TEMPLATE);
}

// The template body's parameters, in order, from WHATSAPP_OTP_BODY_PARAMS.
// A malformed setting falls back to the default rather than failing sends.
function bodyParams(code, { name } = {}) {
  let spec = ['{code}'];
  try {
    const parsed = JSON.parse(process.env.WHATSAPP_OTP_BODY_PARAMS || 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every((p) => typeof p === 'string')) spec = parsed;
  } catch {
    console.error('WHATSAPP_OTP_BODY_PARAMS is not a JSON array of strings; using ["{code}"]');
  }
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return spec.map((p) => ({
    type: 'text',
    // Meta rejects empty text parameters.
    text: p.replace(/\{code\}/g, code).replace(/\{name\}/g, name || 'there').replace(/\{date\}/g, date) || code,
  }));
}

// Sends `code` to `toE164` ('+919876543210') with the OTP template.
//   vars.name — the player's name, for templates that greet them ({name})
// Returns { messageId } (the wamid Meta's webhook reports statuses for).
// Throws WhatsAppSendError if Meta rejects the request.
async function sendOtpWhatsApp(toE164, code, vars = {}) {
  const e = process.env;
  const version = e.WHATSAPP_API_VERSION || DEFAULT_API_VERSION;
  const components = [{ type: 'body', parameters: bodyParams(code, vars) }];
  // Authentication templates with a copy-code or one-tap button need the
  // code again as the button's parameter.
  if (e.WHATSAPP_OTP_COPY_BUTTON !== 'false') {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
  }

  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toE164.replace(/^\+/, ''),
        type: 'template',
        template: { name: e.WHATSAPP_OTP_TEMPLATE, language: { code: e.WHATSAPP_OTP_TEMPLATE_LANG || 'en' }, components },
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    throw new WhatsAppSendError(`WhatsApp request failed: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body.error || {};
    throw new WhatsAppSendError(`WhatsApp API ${res.status}: ${err.message || 'unknown error'}`, {
      httpStatus: res.status,
      code: err.code ?? null,
      subcode: err.error_subcode ?? null,
    });
  }
  const messageId = body.messages && body.messages[0] && body.messages[0].id;
  if (!messageId) throw new WhatsAppSendError('WhatsApp API accepted the request but returned no message id', { httpStatus: res.status });
  return { messageId };
}

// --- Webhook ------------------------------------------------------------------

// Meta signs every webhook POST: X-Hub-Signature-256: sha256=<HMAC-SHA256 of
// the raw body, keyed with the app secret>. Must be checked on the exact
// bytes received, before any JSON parsing.
function isValidSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== 'string' || !header.startsWith('sha256=') || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  if (given.length !== expected.length || !/^[a-f0-9]+$/i.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

// Constant-time comparison for the GET handshake's verify token.
function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const STATUS_RANK = { accepted: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

// The message-status events in a webhook payload, flattened:
// [{ messageId, status, rank, at, errorCode, errorTitle }]. Anything else
// (incoming messages, other fields) is ignored.
function statusEvents(payload) {
  const events = [];
  for (const entry of (payload && Array.isArray(payload.entry) ? payload.entry : [])) {
    for (const change of (Array.isArray(entry.changes) ? entry.changes : [])) {
      if (change.field !== 'messages' || !change.value) continue;
      for (const s of (Array.isArray(change.value.statuses) ? change.value.statuses : [])) {
        if (!s || typeof s.id !== 'string' || !(s.status in STATUS_RANK)) continue;
        const error = Array.isArray(s.errors) && s.errors[0] ? s.errors[0] : null;
        const seconds = Number(s.timestamp);
        events.push({
          messageId: s.id,
          status: s.status,
          rank: STATUS_RANK[s.status],
          at: Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(),
          errorCode: error && Number.isFinite(Number(error.code)) ? Number(error.code) : null,
          errorTitle: error ? String(error.title || error.message || '').slice(0, 200) || null : null,
        });
      }
    }
  }
  return events;
}

module.exports = {
  ERROR,
  STATUS_RANK,
  WhatsAppSendError,
  isWhatsAppConfigured,
  sendOtpWhatsApp,
  isValidSignature,
  tokensMatch,
  statusEvents,
};

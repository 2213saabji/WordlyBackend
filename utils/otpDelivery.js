// Picks the channel for a mobile-verification OTP: WhatsApp when it's
// configured (utils/whatsapp.js), otherwise SMS (utils/sms.js — which, with
// no SMS provider either, throws SmsNotConfiguredError).
const { isWhatsAppConfigured, sendOtpWhatsApp } = require('./whatsapp');
const { sendOtpSms } = require('./sms');

// Returns { channel: 'whatsapp' | 'sms', messageId } (messageId is set for
// WhatsApp only, for delivery statuses).
//   vars.name — the player's name, for WhatsApp templates that use {name}
async function sendOtp(toE164, code, vars = {}) {
  if (isWhatsAppConfigured()) {
    const { messageId } = await sendOtpWhatsApp(toE164, code, vars);
    return { channel: 'whatsapp', messageId };
  }
  await sendOtpSms(toE164, code);
  return { channel: 'sms', messageId: null };
}

module.exports = { sendOtp };

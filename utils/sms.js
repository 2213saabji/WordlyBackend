// SMS delivery for mobile verification OTPs. No provider has been chosen
// yet, so this is the single place to plug one in:
//
//   SMS_PROVIDER unset     → throws SMS_PROVIDER_NOT_CONFIGURED (the OTP
//                            endpoint answers 503, nothing is stored)
//   SMS_PROVIDER=console   → logs the code to the server console. Local
//                            development and testing only — never set this
//                            in production.
//
// To add a real provider (Twilio, MSG91, etc.), add a branch below that sends
// `body` to `toE164` and throws on failure.

class SmsNotConfiguredError extends Error {}

async function sendOtpSms(toE164, code) {
  const provider = process.env.SMS_PROVIDER;
  const body = `${code} is your GuessWord verification code. It expires in 10 minutes. Don't share it with anyone.`;

  if (provider === 'console') {
    console.log(`[sms:console] to ${toE164}: ${body}`);
    return;
  }

  throw new SmsNotConfiguredError('No SMS provider is configured');
}

module.exports = { sendOtpSms, SmsNotConfiguredError };

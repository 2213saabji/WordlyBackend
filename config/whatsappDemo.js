// TEMPORARY — WhatsApp demo settings, hardcoded at the owner's request while
// the Meta account is being verified. Each value is used only when the
// matching environment variable isn't set (see setting() in
// utils/whatsapp.js), so environment variables always win.
//
// To undo: delete this file (and its require in utils/whatsapp.js) once the
// values are back in the environment. This repo is public and these values
// stay in its git history, so afterwards also reset the Meta app secret and
// replace the access token (use a permanent System User token).
module.exports = {
  WHATSAPP_ACCESS_TOKEN: 'EAAWdSZBvy4R4BSh4lStCGyNZC2TJlJLefYsMlAiS8cZBVczimqRg3ZA7ArAHJJD8KSJEwBxmztq2QZB5zB1TGRFS9UPuYBjTLC9xOAVcJTj8bSXjlrUfUlrspgokYf1KngAsBNlZA2HrOFtEMdNJDZCHGDO8FwhfhGZBnNawK6IwjOHN9NoPtls8RoRId6xXBQZDZD',
  WHATSAPP_PHONE_NUMBER_ID: '1337820409416578',
  // Demo template (Meta sample): {{1}} name, {{2}} code, {{3}} date. Swap for
  // a real Authentication template later.
  WHATSAPP_OTP_TEMPLATE: 'jaspers_market_order_confirmation_v1',
  WHATSAPP_OTP_TEMPLATE_LANG: 'en_US',
  WHATSAPP_OTP_BODY_PARAMS: '["{name}","{code}","{date}"]',
  WHATSAPP_OTP_COPY_BUTTON: 'false',
  WHATSAPP_API_VERSION: 'v25.0',
  // App settings > Basic > App secret (verifies webhook signatures)
  WHATSAPP_APP_SECRET: 'dad91c02726a276cc12e97ae1b0fc891',
  // The same value as in WhatsApp > Configuration > Webhook > Verify token
  WHATSAPP_VERIFY_TOKEN: 'Hn3a_yRTEAvXUrdgpymvAHp--DxTIlJ2',
};

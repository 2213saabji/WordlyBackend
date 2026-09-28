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
  WHATSAPP_ACCESS_TOKEN: 'EAAWdSZBvy4R4BSuyUDGKAR9yjhwrLb5gqEDiOykVVZASKfPgXmFOMpYyx5QtrLVuw7prW1uf7h8EJgsXpaDEwCz3BFEihXbGvqoasow5J8lz8Cv0ZBHmKJK6WpaZBJ8AZAeFl64DPvbO6rOs1UyUBTBl6kJx9ip727qnw6JucKn5kPYM67Ljs7lMXg04tRarBNjzZBDu7EmBF8hF81axPKEZCFsYpsRyPgMiMpIZAnD5096EgiWuhZCW9VKYYlOz8ycl5Q0cXU38zu9Hqsuq8mX9WiacZD',
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

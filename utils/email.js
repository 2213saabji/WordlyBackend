const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  return transporter;
}

const NOREPLY_EMAIL_FROM = process.env.NOREPLY_EMAIL_FROM || 'noreply@guessword.games';

let noreplyTransporter = null;

// Password-reset mail goes out as noreply@. Most SMTP hosts (GoDaddy
// included) reject a From that doesn't match the authenticated mailbox, so
// if noreply@ is its own mailbox, give it its own credentials via
// NOREPLY_EMAIL_USER/NOREPLY_EMAIL_PASS. Without them we fall back to the
// shared transporter, which only works if noreply@ is an alias of EMAIL_USER.
function getNoreplyTransporter() {
  if (!process.env.NOREPLY_EMAIL_USER || !process.env.NOREPLY_EMAIL_PASS) {
    return getTransporter();
  }
  if (noreplyTransporter) return noreplyTransporter;

  noreplyTransporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: {
      user: process.env.NOREPLY_EMAIL_USER,
      pass: process.env.NOREPLY_EMAIL_PASS,
    },
  });

  return noreplyTransporter;
}

// Logo tiles spelling the brand name, styled like Wordle tiles (first letter
// accented orange, the "W" accented green, rest dark) — see the inline
// styles below for the shared per-tile look.
function brandTilesHtml(word) {
  const ACCENT_FIRST = '#F2A05C';
  const ACCENT_W = '#7FB069';
  const DARK = '#2A2130';
  const letters = word.split('');
  const wIndex = letters.findIndex((l) => l.toUpperCase() === 'W');

  return letters
    .map((letter, i) => {
      const isAccent = i === 0 || i === wIndex;
      const bg = i === 0 ? ACCENT_FIRST : i === wIndex ? ACCENT_W : DARK;
      const color = isAccent ? '#17111B' : '#F3ECEF';
      const spacer =
        i < letters.length - 1
          ? '<td width="4" style="width:4px;font-size:0;line-height:0;">&nbsp;</td>'
          : '';
      return (
        `<td width="30" height="30" align="center" bgcolor="${bg}" style="width:30px;height:30px;background-color:${bg};border-radius:7px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:${color};mso-line-height-rule:exactly;line-height:30px;">${letter}</td>` +
        spacer
      );
    })
    .join('');
}

// Shared layout for single-action emails (password reset): brand tiles, a
// card with eyebrow/heading/intro, one button, an expiry pill and a
// paste-able fallback link. All `p` fields are
// fixed server strings or server-built URLs, never user input.
function actionEmailHtml(p) {
  return `<body style="margin:0;padding:0;background-color:#0F0B12;">
<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${p.preheader}͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;</span>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0F0B12" style="background-color:#0F0B12;">
  <tbody><tr>
    <td align="center" style="padding:40px 12px;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

        <!-- Logo tiles -->
        <tbody><tr>
          <td align="left" class="pad" style="padding:0 40px 24px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tbody><tr>
                ${brandTilesHtml('GUESSWORD')}
              </tr>
            </tbody></table>
          </td>
        </tr>

        <!-- Card -->
        <tr>
          <td bgcolor="#1F1725" style="background-color:#1F1725;border:1px solid #33283A;border-radius:24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody><tr>
                <td class="pad" style="padding:44px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#9A8AA2;mso-line-height-rule:exactly;line-height:18px;">${p.eyebrow}</td>
              </tr>
              <tr>
                <td class="pad h1" style="padding:12px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:30px;color:#F3ECEF;mso-line-height-rule:exactly;line-height:36px;">${p.heading}</td>
              </tr>
              <tr>
                <td class="pad" style="padding:16px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:25px;">${p.intro}</td>
              </tr>

              <!-- Button -->
              <tr>
                <td class="pad" style="padding:32px 40px 0 40px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tbody><tr>
                      <td align="center" bgcolor="#F2A05C" style="background-color:#F2A05C;border-radius:14px;">
                        <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${p.url}" style="height:52px;v-text-anchor:middle;width:240px;" arcsize="27%" stroke="f" fillcolor="#F2A05C"><center style="color:#17111B;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${p.buttonLabel}</center></v:roundrect><![endif]-->
                        <!--[if !mso]><!-->
                        <a href="${p.url}" target="_blank" style="display:block;padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#17111B;text-decoration:none;border-radius:14px;mso-line-height-rule:exactly;line-height:20px;">${p.buttonLabel}</a>
                        <!--<![endif]-->
                      </td>
                    </tr>
                  </tbody></table>
                </td>
              </tr>

              <!-- Expiry note -->
              <tr>
                <td class="pad" style="padding:20px 40px 0 40px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tbody><tr>
                      <td bgcolor="#2A2130" style="background-color:#2A2130;border-radius:999px;padding:7px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#F2A05C;mso-line-height-rule:exactly;line-height:18px;">${p.expiryLabel}</td>
                    </tr>
                  </tbody></table>
                </td>
              </tr>

              <!-- Divider -->
              <tr>
                <td class="pad" style="padding:36px 40px 0 40px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr><td height="1" bgcolor="#33283A" style="height:1px;background-color:#33283A;font-size:0;line-height:0;">&nbsp;</td></tr></tbody></table>
                </td>
              </tr>

              <!-- Fallback link -->
              <tr>
                <td class="pad" style="padding:24px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9A8AA2;mso-line-height-rule:exactly;line-height:20px;">Button not working? Paste this link into your browser:</td>
              </tr>
              <tr>
                <td class="pad" style="padding:8px 40px 0 40px;font-family:'Courier New',Courier,monospace;font-size:13px;mso-line-height-rule:exactly;line-height:20px;word-break:break-all;">
                  <a href="${p.url}" target="_blank" style="color:#F2A05C;text-decoration:underline;word-break:break-all;">${p.url}</a>
                </td>
              </tr>

              <tr>
                <td class="pad" style="padding:24px 40px 44px 40px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:22px;">${p.ignoreNote}</td>
              </tr>
            </tbody></table>
          </td>
        </tr>

        <!-- Footer -->

      </tbody></table>
    </td>
  </tr>
</tbody></table>

</body>`;
}

async function sendPasswordResetEmail(toEmail, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;

  await getNoreplyTransporter().sendMail({
    from: NOREPLY_EMAIL_FROM,
    to: toEmail,
    subject: 'Reset your GuessWord password',
    html: actionEmailHtml({
      preheader: 'Set a new password for GuessWord. This link expires in 15 minutes.',
      eyebrow: 'Password reset',
      heading: 'You requested a password reset.',
      intro: 'Click the link below to set a new password. This link expires in 15 minutes.',
      buttonLabel: 'Set a new password',
      url: resetUrl,
      expiryLabel: 'Expires in 15 minutes',
      ignoreNote: 'If you did not request this, you can safely ignore this email.',
    }),
  });
}

// Signup email: the 6-digit code as six tiles (3 + 3), an "or" divider,
// then a one-tap verify-and-sign-in button with a paste-able fallback link.
// `email` is the player's input, so it's escaped; code and url are
// server-generated.
function signupVerificationHtml({ email, code, url, ttlMinutes }) {
  const digit = (d) =>
    `<td width="48" height="60" align="center" bgcolor="#2A2030" style="width:48px;height:60px;border:1px solid #3A2E40;border-radius:12px;font-family:'Courier New',Courier,monospace;font-size:28px;font-weight:bold;color:#F3ECEF;">${d}</td>`;
  const gap = (w) => `<td width="${w}" style="width:${w}px;font-size:0;line-height:0;">&nbsp;</td>`;
  const tiles = code
    .split('')
    .map((d, i) => (i === 0 ? '' : gap(i === 3 ? 16 : 8)) + digit(d))
    .join('');
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

  return `<body style="margin:0;padding:0;background:#17111B;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;color:#17111B;">Your GuessWord code is ${spaced}. Or tap the button to verify and sign in. Expires in ${ttlMinutes} minutes.</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#17111B" style="background:#17111B;">
<tbody><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tbody><tr><td bgcolor="#1F1725" style="background:#1F1725;border:1px solid #2E2434;border-radius:20px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tbody><tr><td class="px" style="padding:40px 40px 0;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#F2A05C;font-weight:bold;mso-line-height-rule:exactly;line-height:16px;">Verify your email</div>
      <div style="padding-top:12px;font-size:28px;font-weight:bold;color:#F3ECEF;mso-line-height-rule:exactly;line-height:34px;">Welcome to GuessWord</div>
      <div style="padding-top:12px;font-size:15px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:23px;">Enter this code on the sign-up screen to confirm <span style="color:#F3ECEF;">${escapeHtml(email)}</span>.</div>
    </td></tr>

    <tr><td class="px" align="left" style="padding:28px 40px 0;">
      <table role="presentation" class="otp" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        ${tiles}
      </tr></tbody></table>
    </td></tr>
    <tr><td class="px" style="padding:12px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9A8AA2;mso-line-height-rule:exactly;line-height:19px;">Expires in ${ttlMinutes} minutes.</td></tr>

    <tr><td class="px" style="padding:28px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td width="45%" style="border-top:1px solid #3A2E40;font-size:0;line-height:0;">&nbsp;</td>
        <td align="center" style="padding:0 12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9A8AA2;white-space:nowrap;">or</td>
        <td width="45%" style="border-top:1px solid #3A2E40;font-size:0;line-height:0;">&nbsp;</td>
      </tr></tbody></table>
    </td></tr>

    <tr><td class="px" style="padding:24px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:23px;">Verify and sign in on this device in one tap.</td></tr>
    <tr><td class="px" style="padding:16px 40px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td align="center" bgcolor="#F2A05C" style="border-radius:14px;">
          <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:52px;v-text-anchor:middle;width:518px;" arcsize="27%" stroke="f" fillcolor="#F2A05C"><center style="color:#17111B;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Verify email and sign in</center></v:roundrect><![endif]-->
          <!--[if !mso]><!--><a href="${url}" target="_blank" style="display:block;padding:16px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#17111B;text-decoration:none;border-radius:14px;">Verify email and sign in</a><!--<![endif]-->
        </td>
      </tr></tbody></table>
    </td></tr>
    <tr><td class="px" style="padding:14px 40px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9A8AA2;mso-line-height-rule:exactly;line-height:18px;">Button not working? Paste this into your browser:<br><a href="${url}" target="_blank" style="color:#F2A05C;text-decoration:underline;word-break:break-all;">${url}</a></td></tr>

    <tr><td class="px" style="padding:32px 40px 36px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td bgcolor="#251C2B" style="background:#251C2B;border-radius:12px;padding:16px 18px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:20px;">
          <span style="color:#F3ECEF;font-weight:bold;">Didn't sign up?</span> Ignore this email. No account is created until the email is verified. GuessWord will never ask for this code by phone or chat.
        </td>
      </tr></tbody></table>
    </td></tr>
  </tbody></table>
</td></tr>
</tbody></table>
</td></tr>
</tbody></table>
</body>`;
}

// Signup confirmation: one email carrying both a 6-digit code (typed into
// the signup screen) and a link to the frontend's /verify-signup/:token
// page, which calls POST /api/auth/signup/verify/:token. Either one creates
// the account.
async function sendSignupVerificationEmail(toEmail, token, code, ttlMinutes) {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-signup/${token}`;

  await getNoreplyTransporter().sendMail({
    from: NOREPLY_EMAIL_FROM,
    to: toEmail,
    subject: `${code} is your GuessWord verification code`,
    html: signupVerificationHtml({ email: toEmail, code, url: verifyUrl, ttlMinutes }),
    // Plain-text part for clients that don't render HTML (and better deliverability).
    text: [
      `Welcome to GuessWord`,
      ``,
      `Your verification code is ${code}. Enter it on the sign-up screen to confirm ${toEmail}.`,
      `It expires in ${ttlMinutes} minutes.`,
      ``,
      `Or verify and sign in with this link:`,
      verifyUrl,
      ``,
      `Didn't sign up? Ignore this email. No account is created until the email is verified.`,
      `GuessWord will never ask for this code by phone or chat.`,
    ].join('\n'),
  });
}

// Coin purchase receipt: brand tiles and one card with the order lines.
// Every value is server-built (order id, numbers, dates), never user input.
function formatInr(amountPaise) {
  return `₹${(amountPaise / 100).toFixed(2)}`;
}

function coinReceiptHtml({ orderId, coins, amountPaise, paidAt, balance }) {
  const row = (label, value) => `
              <tr>
                <td class="pad" style="padding:14px 40px 0 40px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
                    <td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#9A8AA2;line-height:22px;">${label}</td>
                    <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#F3ECEF;line-height:22px;">${value}</td>
                  </tr></tbody></table>
                </td>
              </tr>`;
  const date = new Date(paidAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  return `<body style="margin:0;padding:0;background-color:#0F0B12;">
<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${coins.toLocaleString('en-IN')} coins added to your GuessWord wallet.͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0F0B12" style="background-color:#0F0B12;">
  <tbody><tr>
    <td align="center" style="padding:40px 12px;">
      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
        <tbody><tr>
          <td align="left" class="pad" style="padding:0 40px 24px 40px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tbody><tr>${brandTilesHtml('GUESSWORD')}</tr></tbody></table>
          </td>
        </tr>
        <tr>
          <td bgcolor="#1F1725" style="background-color:#1F1725;border:1px solid #33283A;border-radius:24px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tbody><tr>
                <td class="pad" style="padding:44px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#9A8AA2;line-height:18px;">Receipt</td>
              </tr>
              <tr>
                <td class="pad h1" style="padding:12px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:30px;color:#F3ECEF;line-height:36px;">${coins.toLocaleString('en-IN')} coins added.</td>
              </tr>
              <tr>
                <td class="pad" style="padding:16px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#C9BFCC;line-height:25px;">Thanks for your purchase. Your coins are in your wallet and ready to spend on hints.</td>
              </tr>
              ${row('Order', orderId)}
              ${row('Date', date)}
              ${row('Coins', coins.toLocaleString('en-IN'))}
              ${row('Paid (incl. GST)', formatInr(amountPaise))}
              ${row('New balance', `${balance.toLocaleString('en-IN')} coins`)}
              <tr>
                <td class="pad" style="padding:28px 40px 44px 40px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#9A8AA2;line-height:20px;">Coins have no cash value and can't be withdrawn or transferred. Purchases are non-refundable, except where required by law or for a duplicate charge. Questions? Reply to support@guessword.games with your order number.</td>
              </tr>
            </tbody></table>
          </td>
        </tr>
      </tbody></table>
    </td>
  </tr>
</tbody></table>
</body>`;
}

async function sendCoinReceiptEmail(toEmail, receipt) {
  await getNoreplyTransporter().sendMail({
    from: NOREPLY_EMAIL_FROM,
    to: toEmail,
    subject: `Your GuessWord receipt · ${receipt.orderId}`,
    html: coinReceiptHtml(receipt),
    text: [
      `${receipt.coins} coins added to your GuessWord wallet.`,
      `Order: ${receipt.orderId}`,
      `Paid (incl. GST): ${formatInr(receipt.amountPaise)}`,
      `New balance: ${receipt.balance} coins`,
      '',
      "Coins have no cash value and can't be withdrawn or transferred. Purchases are non-refundable, except where required by law or for a duplicate charge.",
    ].join('\n'),
  });
}

// Contact submissions carry free-text user input (name/message) straight
// into an HTML email — escape it so a submission can't inject markup/script
// into the notification or digest emails.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CONTACT_NOTIFY_EMAIL = process.env.CONTACT_NOTIFY_EMAIL || 'support@guessword.games';

// Immediate per-submission notification, sent the moment someone submits
// the contact form (in addition to it being stored for the digest emails).
async function sendContactNotificationEmail(submission) {
  const { category, name, email, message } = submission;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: CONTACT_NOTIFY_EMAIL,
    replyTo: email,
    subject: `[GuessWord Contact] ${category}: ${name}`,
    html: `
      <p><strong>Category:</strong> ${escapeHtml(category)}</p>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
    `,
  });
}

// Shared by both the daily and weekly digest cron jobs — same table layout,
// different recipients/subject/range label.
async function sendContactDigestEmail({ to, subject, rangeLabel, submissions }) {
  const rows = submissions
    .map(
      (s) => `
        <tr>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(new Date(s.createdAt).toISOString())}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(s.category)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(s.name)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(s.email)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(s.message).replace(/\n/g, '<br>')}</td>
        </tr>`
    )
    .join('');

  const html = `
    <p><strong>${escapeHtml(rangeLabel)}</strong> — ${submissions.length} submission${submissions.length === 1 ? '' : 's'}.</p>
    ${
      submissions.length
        ? `<table style="border-collapse:collapse;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:13px;">
            <thead>
              <tr>
                <th style="padding:8px;border:1px solid #ddd;text-align:left;">Received (UTC)</th>
                <th style="padding:8px;border:1px solid #ddd;text-align:left;">Category</th>
                <th style="padding:8px;border:1px solid #ddd;text-align:left;">Name</th>
                <th style="padding:8px;border:1px solid #ddd;text-align:left;">Email</th>
                <th style="padding:8px;border:1px solid #ddd;text-align:left;">Message</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
        : '<p>No submissions in this period.</p>'
    }
  `;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    subject,
    html,
  });
}

module.exports = {
  sendPasswordResetEmail,
  sendSignupVerificationEmail,
  sendCoinReceiptEmail,
  sendContactNotificationEmail,
  sendContactDigestEmail,
};

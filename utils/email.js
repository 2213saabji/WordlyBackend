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

// Shared layout for single-action emails (password reset, email
// verification): brand tiles, a card with eyebrow/heading/intro, one
// button, an expiry pill and a paste-able fallback link. All `p` fields are
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

// Link to the frontend's /verify-email/:token page, which calls
// POST /api/verification/email/confirm with the token.
async function sendEmailVerificationEmail(toEmail, token) {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/verify-email/${token}`;

  await getNoreplyTransporter().sendMail({
    from: NOREPLY_EMAIL_FROM,
    to: toEmail,
    subject: 'Verify your GuessWord email',
    html: actionEmailHtml({
      preheader: 'Confirm this is your email address. This link expires in 24 hours.',
      eyebrow: 'Email verification',
      heading: 'Confirm your email address.',
      intro: 'Click the link below to confirm this email address belongs to you. This link expires in 24 hours.',
      buttonLabel: 'Verify my email',
      url: verifyUrl,
      expiryLabel: 'Expires in 24 hours',
      ignoreNote: 'If you did not ask for this, you can safely ignore this email.',
    }),
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
  sendEmailVerificationEmail,
  sendContactNotificationEmail,
  sendContactDigestEmail,
};

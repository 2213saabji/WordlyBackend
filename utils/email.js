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

async function sendPasswordResetEmail(toEmail, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password/${resetToken}`;

  await getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: toEmail,
    subject: 'Reset your GuessWord password',
    html: `<body style="margin:0;padding:0;background-color:#0F0B12;">
<span style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">Set a new password for GuessWord. This link expires in 15 minutes.͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;͏‌&nbsp;</span>

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
                <td class="pad" style="padding:44px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#9A8AA2;mso-line-height-rule:exactly;line-height:18px;">Password reset</td>
              </tr>
              <tr>
                <td class="pad h1" style="padding:12px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:30px;color:#F3ECEF;mso-line-height-rule:exactly;line-height:36px;">You requested a password reset.</td>
              </tr>
              <tr>
                <td class="pad" style="padding:16px 40px 0 40px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:25px;">Click the link below to set a new password. This link expires in 15 minutes.</td>
              </tr>

              <!-- Button -->
              <tr>
                <td class="pad" style="padding:32px 40px 0 40px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tbody><tr>
                      <td align="center" bgcolor="#F2A05C" style="background-color:#F2A05C;border-radius:14px;">
                        <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${resetUrl}" style="height:52px;v-text-anchor:middle;width:240px;" arcsize="27%" stroke="f" fillcolor="#F2A05C"><center style="color:#17111B;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Set a new password</center></v:roundrect><![endif]-->
                        <!--[if !mso]><!-->
                        <a href="${resetUrl}" target="_blank" style="display:block;padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#17111B;text-decoration:none;border-radius:14px;mso-line-height-rule:exactly;line-height:20px;">Set a new password</a>
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
                      <td bgcolor="#2A2130" style="background-color:#2A2130;border-radius:999px;padding:7px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#F2A05C;mso-line-height-rule:exactly;line-height:18px;">Expires in 15 minutes</td>
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
                  <a href="${resetUrl}" target="_blank" style="color:#F2A05C;text-decoration:underline;word-break:break-all;">${resetUrl}</a>
                </td>
              </tr>

              <tr>
                <td class="pad" style="padding:24px 40px 44px 40px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#C9BFCC;mso-line-height-rule:exactly;line-height:22px;">If you did not request this, you can safely ignore this email.</td>
              </tr>
            </tbody></table>
          </td>
        </tr>

        <!-- Footer -->

      </tbody></table>
    </td>
  </tr>
</tbody></table>

</body>`,
  });
}

module.exports = { sendPasswordResetEmail };

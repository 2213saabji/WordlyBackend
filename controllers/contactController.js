const ContactSubmission = require('../models/ContactSubmission');
const { sendContactNotificationEmail } = require('../utils/email');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MESSAGE_MAX_LENGTH = 4000;

async function submitContact(req, res) {
  const { category, name, email, message } = req.body;

  if (!ContactSubmission.CATEGORIES.includes(category)) {
    return res.status(400).json({
      message: `category must be one of: ${ContactSubmission.CATEGORIES.join(', ')}`,
    });
  }
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ message: 'name is required' });
  }
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ message: 'A valid email is required' });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ message: 'message is required' });
  }
  if (message.length > MESSAGE_MAX_LENGTH) {
    return res.status(400).json({ message: `message must be ${MESSAGE_MAX_LENGTH} characters or fewer` });
  }

  const submission = await ContactSubmission.create({
    category,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    message: message.trim(),
  });

  // Stored regardless; the notification email is best-effort so a transient
  // SMTP hiccup doesn't turn into a 500 for someone just trying to reach us.
  try {
    await sendContactNotificationEmail(submission);
  } catch (err) {
    console.error('Failed to send contact notification email:', err);
  }

  return res.status(201).json({ message: 'Thanks — we got your message.' });
}

module.exports = { submitContact };

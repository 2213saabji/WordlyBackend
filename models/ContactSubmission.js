const mongoose = require('mongoose');

const CATEGORIES = ['bug', 'word-suggestion', 'account', 'groups', 'other'];

const contactSubmissionSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CATEGORIES, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

contactSubmissionSchema.index({ createdAt: 1 }); // digest jobs query/delete by createdAt range

const ContactSubmission = mongoose.model('ContactSubmission', contactSubmissionSchema);
ContactSubmission.CATEGORIES = CATEGORIES;

module.exports = ContactSubmission;

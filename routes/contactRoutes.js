const express = require('express');
const router = express.Router();

const { submitContact } = require('../controllers/contactController');

// Public — no auth. Anyone visiting the contact page can submit, logged in or not.
router.post('/', submitContact);

module.exports = router;

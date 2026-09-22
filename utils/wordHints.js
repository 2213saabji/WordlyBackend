const { WORD_HINTS } = require('../data/wordHints');

// Words not yet covered in data/wordHints.js (see its header comment)
// resolve to "" rather than a fabricated hint.
function hintForWord(word) {
  return WORD_HINTS[word] || '';
}

module.exports = { hintForWord };

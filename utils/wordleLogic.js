/**
 * Evaluates a guess against the target word.
 *
 * Returns an array of per-letter results, one entry per letter of `guess`:
 *   1  -> letter is correct and in the right position
 *  -1  -> letter exists in the target word but in a different position
 *   0  -> letter does not exist in the target word (or all copies of it
 *         were already accounted for by earlier exact/present matches)
 *
 * Duplicate letters are handled the same way the real Wordle does: a
 * letter's copies in the target are "consumed" first by exact-position
 * matches, then by present-but-misplaced matches, so a repeated guess
 * letter is never over-credited.
 */
function evaluateGuess(guess, target) {
  const guessLetters = guess.toLowerCase().split('');
  const targetLetters = target.toLowerCase().split('');
  const result = new Array(guessLetters.length).fill(0);

  const remaining = {};
  for (const letter of targetLetters) {
    remaining[letter] = (remaining[letter] || 0) + 1;
  }

  // Pass 1: exact position matches consume from `remaining` first.
  for (let i = 0; i < guessLetters.length; i++) {
    if (guessLetters[i] === targetLetters[i]) {
      result[i] = 1;
      remaining[guessLetters[i]] -= 1;
    }
  }

  // Pass 2: present-but-wrong-position, limited by what's left in `remaining`.
  for (let i = 0; i < guessLetters.length; i++) {
    if (result[i] === 1) continue;
    const letter = guessLetters[i];
    if (remaining[letter] > 0) {
      result[i] = -1;
      remaining[letter] -= 1;
    } else {
      result[i] = 0;
    }
  }

  return result;
}

function isWin(resultArray) {
  return resultArray.every((value) => value === 1);
}

module.exports = { evaluateGuess, isWin };

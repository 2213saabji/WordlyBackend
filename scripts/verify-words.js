/* Run with:  node scripts/verify-words.js
 * Fails loudly if the word lists or the daily cycle break an invariant. */
const {
  ANSWERS,
  INFINITE_ANSWERS,
  EXTRA_VALID_GUESSES,
  VALID_GUESSES,
  VALID_GUESS_SET,
} = require('../data/words');
const { wordForDate, infiniteWordForRound } = require('../utils/dailyWord');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

const shape = (list) => list.filter((w) => !/^[a-z]{5}$/.test(w));
const dupes = (list) => {
  const seen = new Set(), bad = [];
  for (const w of list) {
    if (seen.has(w)) bad.push(w);
    else seen.add(w);
  }
  return [...new Set(bad)];
};
const isSorted = (list) => list.every((w, i) => i === 0 || list[i - 1] <= w);

console.log('word lists');
check('ANSWERS is 728', ANSWERS.length === 728, ANSWERS.length);
check('INFINITE_ANSWERS is 1456', INFINITE_ANSWERS.length === 1456, INFINITE_ANSWERS.length);
check('all entries are 5 lowercase letters',
  shape([...ANSWERS, ...INFINITE_ANSWERS, ...EXTRA_VALID_GUESSES]).length === 0,
  shape([...ANSWERS, ...INFINITE_ANSWERS, ...EXTRA_VALID_GUESSES]).slice(0, 5).join(','));
check('no duplicates in ANSWERS', dupes(ANSWERS).length === 0, dupes(ANSWERS).join(','));
check('no duplicates in INFINITE_ANSWERS', dupes(INFINITE_ANSWERS).length === 0);
check('no duplicates in EXTRA_VALID_GUESSES', dupes(EXTRA_VALID_GUESSES).length === 0);

const daily = new Set(ANSWERS);
const infinite = new Set(INFINITE_ANSWERS);
const overlapDI = INFINITE_ANSWERS.filter((w) => daily.has(w));
check('daily and infinite pools are disjoint', overlapDI.length === 0, overlapDI.slice(0, 5).join(','));

const overlapED = EXTRA_VALID_GUESSES.filter((w) => daily.has(w));
const overlapEI = EXTRA_VALID_GUESSES.filter((w) => infinite.has(w));
check('extra guesses do not overlap ANSWERS', overlapED.length === 0, overlapED.slice(0, 5).join(','));
check('extra guesses do not overlap INFINITE_ANSWERS', overlapEI.length === 0, overlapEI.slice(0, 5).join(','));

check('ANSWERS is not stored alphabetically', !isSorted(ANSWERS));
check('INFINITE_ANSWERS is not stored alphabetically', !isSorted(INFINITE_ANSWERS));

const unguessable = [...ANSWERS, ...INFINITE_ANSWERS].filter((w) => !VALID_GUESS_SET.has(w));
check('every answer is a valid guess', unguessable.length === 0, unguessable.slice(0, 5).join(','));
check('VALID_GUESSES has no duplicates', VALID_GUESSES.length === VALID_GUESS_SET.size);
check('VALID_GUESSES is a superset of both pools',
  VALID_GUESSES.length >= ANSWERS.length + INFINITE_ANSWERS.length);

console.log('\nguess dictionary (shared across both modes)');
// Guessing is not mode-scoped: an infinite-only answer is still a valid
// daily guess and vice versa - only which pool an answer is drawn FROM is
// mode-scoped (see the daily/infinite cycle checks below).
check('every ANSWERS word is guessable', ANSWERS.every((w) => VALID_GUESS_SET.has(w)));
check('every INFINITE_ANSWERS word is guessable', INFINITE_ANSWERS.every((w) => VALID_GUESS_SET.has(w)));
check('every EXTRA_VALID_GUESSES word is guessable', EXTRA_VALID_GUESSES.every((w) => VALID_GUESS_SET.has(w)));

console.log('\ndaily cycle');
const keys = [];
const start = Date.UTC(2026, 0, 1);
for (let i = 0; i < 728; i++) {
  const d = new Date(start + i * 86400000);
  keys.push(d.toISOString().slice(0, 10));
}
const words = keys.map(wordForDate);
check('728 consecutive days give 728 distinct words',
  new Set(words).size === 728, new Set(words).size + ' distinct');
check('all 728 answers are used exactly once', new Set(words).size === ANSWERS.length);
check('same date always gives the same word',
  wordForDate('2026-05-05') === wordForDate('2026-05-05'));
const next = wordForDate(new Date(start + 728 * 86400000).toISOString().slice(0, 10));
check('day 729 restarts the cycle', next === words[0], next + ' vs ' + words[0]);

console.log('\ninfinite cycle');
const infA = Array.from({ length: 1456 }, (_, i) => infiniteWordForRound('userA', i));
check('1456 rounds give 1456 distinct words',
  new Set(infA).size === 1456, new Set(infA).size + ' distinct');
check('all 1456 infinite answers are used exactly once', new Set(infA).size === INFINITE_ANSWERS.length);
check('same round always gives the same word',
  infiniteWordForRound('userA', 42) === infiniteWordForRound('userA', 42));
const infNext = infiniteWordForRound('userA', 1456);
check('round 1456 restarts the cycle', infNext === infA[0], infNext + ' vs ' + infA[0]);
const infBoundaryPrev = infiniteWordForRound('userA', 1455);
check('no repeat across the cycle boundary', infBoundaryPrev !== infNext);
const infB0 = infiniteWordForRound('userB', 0);
check('different users get different shuffles', infB0 !== infA[0], infB0 + ' vs ' + infA[0]);

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);

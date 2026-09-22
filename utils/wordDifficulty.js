// Derives an easy/medium/hard rating per word from letter rarity and repeats,
// then buckets each mode's answer pool into thirds so ratings stay balanced
// within DAILY and within INFINITE independently.

const { ANSWERS, INFINITE_ANSWERS } = require('../data/words');

// Rank position in approximate English letter-frequency order (lower = more common).
const LETTER_RARITY = {
  e: 1, a: 2, r: 3, i: 4, o: 5, t: 6, n: 7, s: 8, l: 9, c: 10,
  u: 11, d: 12, p: 13, m: 14, h: 15, g: 16, b: 17, f: 18, y: 19, w: 20,
  k: 21, v: 22, x: 23, z: 24, j: 25, q: 26,
};

function rawScore(word) {
  const letters = word.split('');
  const uniqueCount = new Set(letters).size;
  const repeatPenalty = (letters.length - uniqueCount) * 8;
  const rarityScore = letters.reduce((sum, ch) => sum + (LETTER_RARITY[ch] || 26), 0);
  return rarityScore + repeatPenalty;
}

function buildDifficultyMap(words) {
  const scored = words.map((word) => ({ word, score: rawScore(word) }));
  scored.sort((a, b) => a.score - b.score);

  const third = Math.ceil(scored.length / 3);
  const map = new Map();
  scored.forEach(({ word }, i) => {
    const difficulty = i < third ? 'easy' : i < third * 2 ? 'medium' : 'hard';
    map.set(word, difficulty);
  });
  return map;
}

const DAILY_DIFFICULTY = buildDifficultyMap(ANSWERS);
const INFINITE_DIFFICULTY = buildDifficultyMap(INFINITE_ANSWERS);

function difficultyForDailyWord(word) {
  return DAILY_DIFFICULTY.get(word) || 'medium';
}

function difficultyForInfiniteWord(word) {
  return INFINITE_DIFFICULTY.get(word) || 'medium';
}

module.exports = { difficultyForDailyWord, difficultyForInfiniteWord };

// Сравнение чанков без ИИ: одинаковые и почти одинаковые формулировки.

const IGNORED = new Set(["a", "an", "the", "to", "i", "my", "your", "some"]);
const MAX_DISTANCE_SHARE = 0.2;
const MIN_LENGTH_FOR_TYPOS = 8;

export function chunkKey(text) {
  const words = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((word) => !IGNORED.has(word));
  return (meaningful.length ? meaningful : words).join(" ");
}

// Расстояние Левенштейна с ранним выходом, чтобы не тратить лимит CPU.
function withinDistance(first, second, limit) {
  if (Math.abs(first.length - second.length) > limit) return false;
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row += 1) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= second.length; column += 1) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      const value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + cost,
      );
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return false;
    previous = current;
  }
  return previous[second.length] <= limit;
}

// Заранее считает всё нужное для сравнения, чтобы не повторять работу.
function prepare(chunk) {
  const key = chunkKey(chunk.text);
  const words = key.split(" ");
  const letters = new Map();
  for (const letter of key) letters.set(letter, (letters.get(letter) || 0) + 1);
  return { ...chunk, key, words, wordSet: new Set(words), letters };
}

function containsWords(shorter, longer) {
  return (
    shorter.words.length >= 2 &&
    shorter.words.length / longer.wordSet.size >= 0.5 &&
    shorter.words.every((word) => longer.wordSet.has(word))
  );
}

// Быстрая отсечка: разные наборы букв не дают маленького расстояния.
function lettersClose(first, second, limit) {
  let different = 0;
  for (const [letter, count] of first.letters) {
    different += Math.max(0, count - (second.letters.get(letter) || 0));
    if (different > limit) return false;
  }
  return true;
}

function isSimilar(first, second) {
  const longest = Math.max(first.key.length, second.key.length);
  const limit = Math.floor(longest * MAX_DISTANCE_SHARE);
  if (
    longest >= MIN_LENGTH_FOR_TYPOS &&
    lettersClose(first, second, limit) &&
    lettersClose(second, first, limit) &&
    withinDistance(first.key, second.key, limit)
  ) {
    return true;
  }
  return first.words.length <= second.words.length
    ? containsWords(first, second)
    : containsWords(second, first);
}

// Делит новые строки на новые, точные повторы и похожие.
export function compareChunks(existing, rows) {
  const known = existing.map(prepare);
  const fresh = [];
  const duplicates = [];
  const similar = [];
  for (const row of rows) {
    const candidate = prepare({ id: null, text: row[0] });
    if (known.some((chunk) => chunk.key === candidate.key)) {
      duplicates.push(row[0]);
      continue;
    }
    const match = known.find((chunk) => isSimilar(candidate, chunk));
    if (match) similar.push({ text: row[0], match });
    fresh.push(row);
    known.push(candidate);
  }
  return { fresh, duplicates, similar };
}

// Находит пары уже добавленных одинаковых или похожих чанков.
export function findDuplicatePairs(chunks) {
  const items = chunks.map(prepare);
  const pairs = [];
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const a = items[left];
      const b = items[right];
      if (a.key === b.key || isSimilar(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

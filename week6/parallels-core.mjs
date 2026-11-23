// Finding parallels between two texts with n-grams.
// No page code here: the functions work on the tokens made by prepareText()
// (prepare.mjs) and can also be used from Node.
//
// Two ways of comparing:
//  - findPassages(): running text. Shared n-grams that follow each other in
//    both texts are chained into passages of any length.
//  - compareUnits(): the texts are cut into units (verses, sūtras, lines) and
//    every unit of A is compared with every unit of B.
// Both sort their results into
//  - 'one-to-one': found in one place in each text,
//  - 'repeated':   one side matches a few places of the other,
// and findPassages() also returns
//  - recurring phrases: n-grams found more often than `maxFreq` times in
//    either text (formulae such as "iti ha smāha bhagavān ātreyaḥ"). They are
//    not paired place by place but listed once with all their occurrences.

const SEP = '\u0001';

const gramAt = (keys, i, n) => {
  let g = keys[i];
  for(let k = 1; k < n; k++) g = g + SEP + keys[i + k];
  return g;
};

const gramIndex = (keys, n) => {
  const index = new Map();
  for(let i = 0; i + n <= keys.length; i++) {
    const g = gramAt(keys, i, n);
    const list = index.get(g);
    if(list) list.push(i);
    else index.set(g, [i]);
  }
  return index;
};

// tokens that are only whitespace or punctuation do not make a match
const isEmptyKey = k => !/[\p{L}\p{N}]/u.test(k);

// Only tokens with letters or digits are compared, and only their letters and
// digits, so that punctuation (| or //), verse numbers, ignored markup, word
// division (punar alpa / punaralpa), hyphens (also at a line break in OCR)
// and avagraha do not interrupt a match.
// Returns the compared tokens and their positions among all tokens.
const compress = keys => {
  const k = [], pos = [];
  for(let i = 0; i < keys.length; i++) {
    if(isEmptyKey(keys[i])) continue;
    k.push(keys[i].replace(/[^\p{L}\p{M}\p{N}]+/gu, ''));
    pos.push(i);
  }
  return {keys: k, pos};
};

// position in the compressed tokens of the first compared token at or after token i
const lowerBound = (arr, v) => {
  let lo = 0, hi = arr.length;
  while(lo < hi) {
    const mid = (lo + hi) >> 1;
    if(arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
};

/*
 * A, B: {keys: [...]}  (pass the same object twice to find repetitions within one text)
 * options:
 *   n          n-gram size
 *   maxFreq    an n-gram found more often than this in either text is a recurring phrase
 *   maxGap     how many tokens a passage may skip (variants, insertions) and still continue
 *   minLength  shortest passage kept, in tokens
 *   minSimilarity  lowest share of a passage covered by shared n-grams (0–1)
 */
export const findPassages = (fullA, fullB, {n = 6, maxFreq = 4, maxGap = 12, minLength = 12, minSimilarity = 0} = {}) => {
  n = parseInt(n);
  // comparing a text with itself finds its repetitions: each pair of places
  // is then found once, and a place is not matched with itself
  const self = fullA === fullB;
  const A = compress(fullA.keys), B = self ? A : compress(fullB.keys);
  // back to positions among all tokens: [start, end) of compressed tokens
  const spanA = (s, e) => [A.pos[s], A.pos[e - 1] + 1];
  const spanB = (s, e) => [B.pos[s], B.pos[e - 1] + 1];
  const indexA = gramIndex(A.keys, n);
  const indexB = self ? indexA : gramIndex(B.keys, n);

  // 1. seeds: places where the same n-gram occurs in both texts
  const seeds = [];
  const frequent = new Set();
  for(const [g, posA] of indexA) {
    const posB = indexB.get(g);
    if(!posB) continue;
    if(posA.length > maxFreq || posB.length > maxFreq) {
      frequent.add(g);
      continue;
    }
    for(const i of posA) for(const j of posB)
      if(!self || j > i + maxGap + n) seeds.push([i, j]);
  }
  seeds.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // 2. chain seeds that follow each other in both texts into passages,
  //    allowing small shifts of the diagonal (insertions, omissions)
  const drift = Math.max(2, Math.floor(maxGap / 2));
  const open = new Map(); // diagonal -> chain
  const chains = [];
  for(const [i, j] of seeds) {
    const d = j - i;
    let best = null;
    for(let dd = 0; dd <= drift && !best; dd++) {
      for(const cand of dd === 0 ? [d] : [d - dd, d + dd]) {
        const c = open.get(cand);
        if(!c) continue;
        if(i > c.lastI && i - c.lastI <= maxGap && j > c.lastJ && j - c.lastJ <= maxGap) {
          best = c;
          break;
        }
      }
    }
    if(best) {
      if(open.get(best.d) === best) open.delete(best.d);
      best.lastI = i; best.lastJ = j; best.d = d; best.seeds++;
    }
    else {
      best = {firstI: i, firstJ: j, lastI: i, lastJ: j, d: d, seeds: 1};
      chains.push(best);
    }
    open.set(d, best);
  }

  // 2b. join chains that continue each other in both texts after a longer
  //     interruption (a variant reading, an added word or pāda)
  const joinGap = 3 * maxGap;
  chains.sort((x, y) => x.firstI - y.firstI);
  const joined = [];
  let active = [];
  for(const c of chains) {
    active = active.filter(m => c.firstI - m.lastI <= joinGap);
    let target = null;
    for(const m of active) {
      if(c.firstI <= m.lastI - n || c.lastI <= m.lastI) continue;
      const dj = c.firstJ - m.lastJ;
      if(dj > -n && dj <= joinGap && c.lastJ > m.lastJ &&
         Math.abs((c.firstJ - c.firstI) - (m.lastJ - m.lastI)) <= joinGap) {
        if(!target || m.seeds > target.seeds) target = m;
      }
    }
    if(target) {
      target.lastI = c.lastI; target.lastJ = c.lastJ; target.seeds += c.seeds;
    }
    else {
      const m = {...c};
      joined.push(m);
      active.push(m);
    }
  }

  // passages begin and end with whole words where the tokens show word ends
  const wordEdges = (keys, s, e) => {
    for(let k = 0; k < 20 && s > 0 && !/\s$/.test(keys[s - 1]); k++) s--;
    for(let k = 0; k < 20 && e < keys.length && !/\s$/.test(keys[e - 1]); k++) e++;
    return [s, e];
  };

  let passages = [];
  for(const c of joined) {
    const lenA = c.lastI + n - c.firstI, lenB = c.lastJ + n - c.firstJ;
    if(Math.max(lenA, lenB) < minLength) continue;
    if((c.seeds + n - 1) / Math.max(lenA, lenB) < minSimilarity) continue;
    const [aStart, aEnd] = wordEdges(fullA.keys, ...spanA(c.firstI, c.lastI + n));
    const [bStart, bEnd] = wordEdges(fullB.keys, ...spanB(c.firstJ, c.lastJ + n));
    passages.push({
      aStart, aEnd, bStart, bEnd,
      length: Math.max(lenA, lenB), // in compared tokens
      // share of the passage covered by shared n-grams
      similarity: Math.min(1, (c.seeds + n - 1) / Math.max(lenA, lenB)),
    });
  }

  // 3. one-to-one or repeated: does the passage overlap other passages
  //    (of at least half its length) in A or in B?
  passages.sort((x, y) => x.aStart - y.aStart || x.bStart - y.bStart);
  const len = p => p.length;
  const byLength = [...passages].sort((x, y) => len(x) - len(y));
  for(const p of passages) {
    // only passages of at least half this length count
    const half = len(p) / 2;
    let nA = 0, nB = 0;
    for(let k = byLength.length - 1; k >= 0 && len(byLength[k]) >= half; k--) {
      const q = byLength[k];
      if(q.aStart < p.aEnd && q.aEnd > p.aStart) nA++;
      if(q.bStart < p.bEnd && q.bEnd > p.bStart) nB++;
    }
    p.placesInA = nB; // how many places in A share this place of B
    p.placesInB = nA; // how many places in B share this place of A
    p.type = nA === 1 && nB === 1 ? 'one-to-one' : 'repeated';
  }
  passages.forEach((p, k) => p.id = k);

  // 4. recurring phrases: runs of frequent n-grams. Frequent n-grams that
  //    occur in the same run belong to the same phrase (e.g. all the n-grams of
  //    "athāto ... adhyāyaṃ vyākhyāsyāmaḥ"), so the runs are grouped by that.
  const runs = (keys, index) => {
    const marks = new Uint8Array(keys.length + 1);
    for(const g of frequent) {
      const pos = index.get(g);
      if(pos) for(const i of pos) marks[i] = 1;
    }
    const out = [];
    for(let i = 0; i < keys.length; i++) {
      if(!marks[i]) continue;
      let e = i;
      while(marks[e + 1]) e++;
      out.push([i, e + n]);
      i = e;
    }
    return out;
  };
  const runsA = runs(A.keys, indexA);
  const runsB = runs(B.keys, indexB);
  const parent = new Map();
  const find = g => {
    while(parent.get(g) !== g) {
      parent.set(g, parent.get(parent.get(g)));
      g = parent.get(g);
    }
    return g;
  };
  for(const g of frequent) parent.set(g, g);
  const firstGram = (keys, [s, e]) => {
    let first = null;
    for(let i = s; i + n <= e; i++) {
      const g = gramAt(keys, i, n);
      if(!frequent.has(g)) continue;
      if(first === null) first = find(g);
      else {
        const r = find(g);
        if(r !== first) parent.set(r, first);
      }
    }
    return first;
  };
  for(const r of runsA) firstGram(A.keys, r);
  for(const r of runsB) firstGram(B.keys, r);
  const groups = new Map();
  const addRun = (keys, r, side) => {
    const root = find(gramAt(keys, r[0], n));
    let grp = groups.get(root);
    if(!grp) {
      grp = {a: [], b: []};
      groups.set(root, grp);
    }
    grp[side].push(r);
  };
  for(const r of runsA) addRun(A.keys, r, 'a');
  for(const r of runsB) addRun(B.keys, r, 'b');
  const phrases = [...groups.values()]
    .filter(grp => grp.a.length > 0 && grp.b.length > 0)
    .map(grp => ({a: grp.a.map(r => wordEdges(fullA.keys, ...spanA(...r))),
                  b: grp.b.map(r => wordEdges(fullB.keys, ...spanB(...r)))}))
    .sort((x, y) => (y.a.length + y.b.length) - (x.a.length + x.b.length));
  phrases.forEach((ph, k) => ph.id = k);

  return {passages, phrases};
};

/*
 * Cuts a text into units. `starts` is a regular expression (flags g and m)
 * matching where a unit begins, e.g. /^/gm for every line.
 * `offsets` are the character offsets of the tokens in the original text.
 * Returns token ranges [start, end).
 */
export const splitUnits = (text, offsets, starts) => {
  const charStarts = [0];
  for(const m of text.matchAll(starts)) {
    if(m.index > charStarts[charStarts.length - 1]) charStarts.push(m.index);
  }
  const units = [];
  let t = 0;
  for(let u = 0; u < charStarts.length; u++) {
    const end = u + 1 < charStarts.length ? charStarts[u + 1] : Infinity;
    const s = t;
    while(t < offsets.length && offsets[t] < end) t++;
    if(t > s) units.push([s, t]);
  }
  return units;
};

/*
 * Compares every unit of A with every unit of B.
 * options:
 *   n          n-gram size (n-grams do not cross unit boundaries)
 *   minScore   lowest similarity kept (0–1; Dice coefficient of the n-gram sets)
 *   maxFreq    an n-gram found in more units than this, in either text, still counts
 *              for the similarity but is not used to find candidates
 */
export const compareUnits = (fullA, fullB, unitsA, unitsB, {n = 3, minScore = 0.5, maxFreq = 20} = {}) => {
  n = parseInt(n);
  const A = compress(fullA.keys), B = compress(fullB.keys);
  const gramSets = ({keys, pos}, units) => units.map(([us, ue]) => {
    const s = lowerBound(pos, us), e = lowerBound(pos, ue);
    const set = new Set();
    for(let i = s; i + n <= e; i++) set.add(gramAt(keys, i, n));
    // a unit shorter than n tokens is compared as a whole
    if(set.size === 0 && e > s) set.add(keys.slice(s, e).join(SEP));
    return set;
  });
  const setsA = gramSets(A, unitsA);
  const setsB = gramSets(B, unitsB);
  const unitCount = sets => {
    const count = new Map();
    for(const set of sets) for(const g of set) count.set(g, (count.get(g) || 0) + 1);
    return count;
  };
  const countA = unitCount(setsA), countB = unitCount(setsB);
  // Frequent n-grams count towards the similarity of two units, but only the
  // rarer ones are used to find which units to compare at all (otherwise every
  // unit would be compared with every other through n-grams like "ta" or "ca").
  const rare = g => (countA.get(g) || 0) <= maxFreq && (countB.get(g) || 0) <= maxFreq;
  const index = new Map();
  for(const [k, set] of setsB.entries())
    for(const g of set) {
      if(!countA.has(g) || !rare(g)) continue;
      const list = index.get(g);
      if(list) list.push(k); else index.set(g, [k]);
    }

  const pairs = [];
  for(const [a, set] of setsA.entries()) {
    const candidates = new Set();
    for(const g of set) {
      const list = index.get(g);
      if(list) for(const b of list) candidates.add(b);
    }
    for(const b of candidates) {
      const other = setsB[b];
      let shared = 0;
      const [small, large] = set.size <= other.size ? [set, other] : [other, set];
      for(const g of small) if(large.has(g)) shared++;
      const score = 2 * shared / (set.size + other.size);
      if(score >= minScore) pairs.push({a, b, similarity: score});
    }
  }
  const perA = new Map(), perB = new Map();
  for(const p of pairs) {
    perA.set(p.a, (perA.get(p.a) || 0) + 1);
    perB.set(p.b, (perB.get(p.b) || 0) + 1);
  }
  for(const p of pairs) {
    p.placesInB = perA.get(p.a);
    p.placesInA = perB.get(p.b);
    p.type = p.placesInA === 1 && p.placesInB === 1 ? 'one-to-one' : 'repeated';
    [p.aStart, p.aEnd] = unitsA[p.a];
    [p.bStart, p.bEnd] = unitsB[p.b];
  }
  pairs.sort((x, y) => x.a - y.a || y.similarity - x.similarity);
  pairs.forEach((p, k) => p.id = k);
  const unmatchedA = unitsA.filter((u, k) => !perA.has(k) && setsA[k].size > 0);
  const unmatchedB = unitsB.filter((u, k) => !perB.has(k) && setsB[k].size > 0);
  return {passages: pairs, unmatchedA, unmatchedB};
};

/*
 * Locations for token positions: a reference and the line number.
 * `refs` is a regular expression (flags g and m); by default each match labels
 * the text after it, until the next match. Options:
 *   label(match)  makes the label (default: the groups, or the whole match)
 *   following     the reference stands after the text it labels, like a verse
 *                 number at the end of a verse: the next match is used
 */
export const locator = (text, offsets, refs, {label, following = false} = {}) => {
  const lineStarts = [0];
  for(let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const defaultLabel = m => (m[1] !== undefined ? m.slice(1).filter(x => x !== undefined).join(' ') : m[0])
    .replace(/[\\{}]/g, ' ').replace(/\s+/g, ' ').trim();
  const refList = [];
  if(refs) for(const m of text.matchAll(refs)) {
    const l = (label || defaultLabel)(m);
    if(l) refList.push([m.index, l]);
  }
  const lastAtOrBefore = (arr, v, get) => {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while(lo <= hi) {
      const mid = (lo + hi) >> 1;
      if(get(arr[mid]) <= v) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  };
  return token => {
    const offset = offsets[Math.min(token, offsets.length - 1)] || 0;
    const line = lastAtOrBefore(lineStarts, offset, x => x) + 1;
    let r = lastAtOrBefore(refList, offset, x => x[0]);
    if(following) r = r + 1 < refList.length ? r + 1 : -1;
    return {line, ref: r >= 0 ? refList[r][1] : ''};
  };
};

// character offset of every token
export const tokenOffsets = display => {
  const offsets = new Array(display.length);
  let o = 0;
  for(let i = 0; i < display.length; i++) { offsets[i] = o; o += display[i].length; }
  return offsets;
};

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};

// CSV with a byte order mark, so that spreadsheet programs read it as UTF-8
export const toCSV = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

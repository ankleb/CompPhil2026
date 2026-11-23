import { populateFilters, getMethod, getFilterIndices, prepareText } from './prepare.mjs';
import { findPassages, compareUnits, splitUnits, locator, tokenOffsets, toCSV } from './parallels-core.mjs';

const $ = id => document.getElementById(id);

// ---------- settings ----------

const PRESETS = {
  prose: {mode: 'passages', tokenization: 'eluttu', ngramsize: 6, maxfreq: 4, maxgap: 12, minlength: 12, minscore: 25},
  verse: {mode: 'units', unitpreset: '^', tokenization: 'eluttu', ngramsize: 3, maxfreq: 20, minscore: 60},
  sutra: {mode: 'units', unitpreset: '^', tokenization: 'eluttu', ngramsize: 2, maxfreq: 30, minscore: 50},
};

const REFS = {
  both: '^(?:\\\\([a-z]+)\\{((?:pre )?\\d[^}\\n]*)\\}|\\s*(\\d+(?:\\.\\d+)+[a-z]*))',
  numbers: '^\\s*(\\d+(?:\\.\\d+)+[a-z]*)',
  tex: '^\\\\([a-z]+)\\{((?:pre )?\\d[^}\\n]*)\\}',
  verseend: '(?:\\|\\||//|॥|[.|/])\\s*(\\d+)\\s*(?:\\|\\||//|॥|[.|/])',
  pages: 'END_OF_PAGE_0*(\\d+)',
  none: '',
};
// how a match of the reference pattern becomes a label
const REFLABELS = {
  verseend: {label: m => 'before v. ' + m[1], following: true},
  pages: {label: m => 'p. ' + (parseInt(m[1]) + 1)}, // the marker ends a page
};
const IGNORE = '^\\s*%.*$|\\\\[a-z]+\\{[^}\\n]*\\}|\\\\[a-z]+(?:%\\S*)?|^\\s*\\d+(?:\\.\\d+)+[a-z]*|END_OF_PAGE_\\d+';

const getMode = () => document.querySelector('input[name="mode"]:checked').value;
const showMode = () => { document.body.className = getMode(); };

const applyPreset = () => {
  const p = PRESETS[$('preset').value];
  document.querySelector(`input[name="mode"][value="${p.mode}"]`).checked = true;
  document.querySelector(`input[name="tokenization"][value="${p.tokenization}"]`).checked = true;
  for(const key of ['ngramsize', 'maxfreq', 'maxgap', 'minlength', 'minscore'])
    if(p[key] !== undefined) $(key).value = p[key];
  if(p.unitpreset !== undefined) {
    $('unitpreset').value = p.unitpreset;
    $('unitpattern').value = p.unitpreset;
  }
  showMode();
};

const regex = (source, what) => {
  if(!source) return null;
  try { return new RegExp(source, 'gmu'); }
  catch(e) { throw new Error(`The ${what} pattern is not a valid regular expression: ${e.message}`); }
};

// ---------- loading texts ----------

const loadFile = async e => {
  const file = e.target.files[0];
  if(!file) return;
  const box = $(e.target.dataset.target);
  if(box.textContent.trim() !== '' && !window.confirm('Replace the existing text?')) {
    e.target.value = '';
    return;
  }
  const text = await file.text();
  box.textContent = text.replace(/^\uFEFF/, '');
  box.dataset.name = file.name.replace(/\.[^.]+$/, '');
  delete box.dataset.copyOfA;
  e.target.value = '';
};

// ---------- state ----------

const S = {
  texts: null,     // [A, B], each {orig, display, keys, offsets, loc, units, box}
  result: null,    // {mode, passages, phrases, unmatchedA, unmatchedB}
  tab: 'one-to-one',
  sort: null,      // {col, dir}
  cycle: {key: null, k: 0},
  cache: new Map(),
};

const textName = (k) => (k === 1 && S.result?.self) ? 'itself' :
  $(k === 0 ? 'textA' : 'textB').dataset.name || (k === 0 ? 'A' : 'B');

// With "automatic" references, each text gets the style it uses most clearly.
const autoRefs = text => {
  const count = source => (text.match(new RegExp(source, 'gmu')) || []).length;
  if(count(REFS.pages) >= 3) return 'pages';
  if(count(REFS.both) >= 20) return 'both';
  if(count(REFS.verseend) >= 5) return 'verseend';
  return 'none';
};

// preparing a long text takes a few seconds, so keep the last result per box
const prepared = (box, method, filterindices, filternames, ignore, chosenRefs) => {
  const orig = box.textContent.trim();
  const style = $('refpreset').value === 'auto' ? autoRefs(orig) : $('refpreset').value;
  const refs = style === 'auto' || style === 'custom' ? chosenRefs : regex(REFS[style], 'reference');
  const key = [method, filterindices.join(','), ignore?.source, refs?.source, style].join('\u0001');
  const hit = S.cache.get(box.id);
  if(hit && hit.orig === orig && hit.key === key) return hit;
  const {display, keys} = prepareText(orig, method, filterindices, filternames, ignore);
  const offsets = tokenOffsets(display);
  const refStyle = REFLABELS[style] || {};
  const out = {orig, key, display, keys, offsets, loc: locator(orig, offsets, refs, refStyle), box};
  S.cache.set(box.id, out);
  return out;
};

// ---------- running ----------

const status = msg => { $('status').textContent = msg; };

const run = () => {
  status('Working… (a long text can take a few seconds)');
  $('run').disabled = true;
  setTimeout(() => {
    try { compute(); }
    catch(e) { status('⚠ ' + e.message); console.error(e); }
    $('run').disabled = false;
  }, 30);
};

const compute = () => {
  const t0 = performance.now();
  const boxes = [$('textA'), $('textB')];
  if(boxes[0].textContent.trim() === '') throw new Error('Load or paste text A first (and text B, unless you want to find repetitions within text A).');
  // no text B, or B is the copy of A shown after the last search for repetitions
  const self = boxes[1].textContent.trim() === '' || boxes[1].dataset.copyOfA === 'yes';
  const method = getMethod();
  const [filterindices, filternames] = getFilterIndices(document);
  const refs = regex($('refpattern').value, 'reference');
  const ignore = $('ignoremarkup').checked ? regex($('ignorepattern').value, 'markup') : null;
  const texts = self ? [prepared(boxes[0], method, filterindices, filternames, ignore, refs)]
                     : boxes.map(b => prepared(b, method, filterindices, filternames, ignore, refs));
  // within one text: text A is also shown in box B, so that both places of
  // a repetition can be seen side by side
  if(self) {
    texts.push({...texts[0], box: boxes[1]});
    boxes[1].dataset.copyOfA = 'yes';
  }
  const t1 = performance.now();
  const mode = getMode();
  let result;
  if(mode === 'passages') {
    result = findPassages(texts[0], self ? texts[0] : texts[1], {
      n: $('ngramsize').value, maxFreq: +$('maxfreq').value,
      maxGap: +$('maxgap').value, minLength: +$('minlength').value,
      minSimilarity: +$('minscore').value / 100,
    });
  }
  else {
    const starts = regex($('unitpattern').value || '^', 'unit');
    for(const t of texts) t.units = splitUnits(t.orig, t.offsets, starts);
    if(self) throw new Error('Finding repetitions within one text works with running text; choose “Prose or commentary”.');
    result = compareUnits(texts[0], texts[1], texts[0].units, texts[1].units, {
      n: $('ngramsize').value, maxFreq: +$('maxfreq').value, minScore: +$('minscore').value / 100,
    });
    result.phrases = [];
  }
  result.mode = mode;
  result.self = self;
  S.texts = texts;
  S.result = result;
  S.sort = null;
  S.tab = 'one-to-one';
  render();
  const secs = x => (x / 1000).toFixed(1);
  status(`Done in ${secs(performance.now() - t0)} s (preparing the texts ${secs(t1 - t0)} s).`);
};

// ---------- rows for the table and the CSV ----------

const clip = (str, max = 220) => {
  const s = str.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + ' …' : s;
};
const textOf = (t, s, e) => t.display.slice(s, e).join('');
const where = (t, tok) => t.loc(tok);
const refList = (t, spans, max = Infinity) => {
  const out = [];
  for(const [s] of spans) {
    const l = where(t, s);
    out.push(l.ref ? l.ref : 'l. ' + l.line);
    if(out.length >= max) break;
  }
  return out;
};
const mostCommon = (t, spans) => {
  const count = new Map();
  for(const [s, e] of spans) {
    const w = clip(textOf(t, s, e), 10000);
    count.set(w, (count.get(w) || 0) + 1);
  }
  return [...count].sort((x, y) => y[1] - x[1])[0]?.[0] || '';
};

const TABS = [
  {id: 'one-to-one', label: 'One-to-one'},
  {id: 'repeated', label: 'Repeated'},
  {id: 'phrases', label: 'Recurring phrases', mode: 'passages'},
  {id: 'unmatchedA', label: 'No match: units of A', mode: 'units'},
  {id: 'unmatchedB', label: 'No match: units of B', mode: 'units'},
];

const tabItems = id => {
  const r = S.result;
  if(id === 'phrases') return r.phrases;
  if(id === 'unmatchedA') return r.unmatchedA;
  if(id === 'unmatchedB') return r.unmatchedB;
  return r.passages.filter(p => p.type === id);
};

// columns: [header, value(item), kind]  kind: 'num' | 'ref' | 'text'
const columns = id => {
  const [A, B] = S.texts;
  if(id === 'phrases') return [
    ['Wording in A', ph => clip(mostCommon(A, ph.a)), 'text'],
    ['× in A', ph => ph.a.length, 'num'],
    ['Wording in B', ph => clip(mostCommon(B, ph.b)), 'text'],
    ['× in B', ph => ph.b.length, 'num'],
    ['First places in A', ph => refList(A, ph.a, 6).join('; '), 'text'],
    ['First places in B', ph => refList(B, ph.b, 6).join('; '), 'text'],
  ];
  if(id === 'unmatchedA' || id === 'unmatchedB') {
    const t = id === 'unmatchedA' ? A : B;
    return [
      ['Reference', u => where(t, u[0]).ref, 'ref'],
      ['Line', u => where(t, u[0]).line, 'num'],
      ['Text', u => clip(textOf(t, u[0], u[1])), 'text'],
    ];
  }
  return [
    ['Ref. A', p => where(A, p.aStart).ref, 'ref'],
    ['Line A', p => where(A, p.aStart).line, 'num'],
    ['Text A', p => clip(textOf(A, p.aStart, p.aEnd)), 'text'],
    ['Ref. B', p => where(B, p.bStart).ref, 'ref'],
    ['Line B', p => where(B, p.bStart).line, 'num'],
    ['Text B', p => clip(textOf(B, p.bStart, p.bEnd)), 'text'],
    ['Similarity', p => Math.round(p.similarity * 100), 'num'],
    ...(id === 'repeated' ? [['Places A : B', p => `${p.placesInA} : ${p.placesInB}`, 'ref']] : []),
  ];
};

// ---------- rendering ----------

const MAXROWS = 1000;

const render = () => {
  renderTexts();
  $('results').hidden = false;
  renderTabs();
  renderTable();
};

const renderTabs = () => {
  const tabs = $('tabs');
  tabs.innerHTML = '';
  for(const tab of TABS) {
    if(tab.mode && tab.mode !== S.result.mode) continue;
    const b = document.createElement('button');
    b.textContent = `${tab.label} (${tabItems(tab.id).length})`;
    b.className = tab.id === S.tab ? 'active' : '';
    b.addEventListener('click', () => { S.tab = tab.id; S.sort = null; renderTabs(); renderTable(); });
    tabs.appendChild(b);
  }
};

const renderTable = () => {
  const cols = columns(S.tab);
  let items = tabItems(S.tab).map(item => ({item, values: cols.map(c => c[1](item))}));
  if(S.sort) {
    const {col, dir} = S.sort;
    const num = cols[col][2] === 'num';
    items.sort((x, y) => {
      const a = x.values[col], b = y.values[col];
      const c = num ? a - b : String(a).localeCompare(String(b), undefined, {numeric: true});
      return dir * c;
    });
  }
  const table = $('table');
  table.innerHTML = '';
  const head = table.createTHead().insertRow();
  cols.forEach(([h], k) => {
    const th = document.createElement('th');
    th.textContent = h + (S.sort?.col === k ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : '');
    th.title = 'Sort by this column';
    th.addEventListener('click', () => {
      S.sort = {col: k, dir: S.sort?.col === k ? -S.sort.dir : 1};
      renderTable();
    });
    head.appendChild(th);
  });
  const body = table.createTBody();
  for(const {item, values} of items.slice(0, MAXROWS)) {
    const tr = body.insertRow();
    values.forEach((v, k) => {
      const td = tr.insertCell();
      td.className = cols[k][2];
      td.textContent = v;
    });
    tr.addEventListener('click', () => {
      for(const sel of body.querySelectorAll('tr.selected')) sel.classList.remove('selected');
      tr.classList.add('selected');
      showItem(S.tab, item);
    });
  }
  const notes = {
    'one-to-one': 'Found in one place in each text.',
    'repeated': 'One side matches several places of the other (Places A : B). Often a formula with one variable part, or a verse quoted twice.',
    'phrases': 'Formulae and common expressions, found more often than the “recurring” limit in either text. Click a row, then click the blue phrase in a text to step through its places.',
    'unmatchedA': 'Units of A without a counterpart in B above the similarity limit.',
    'unmatchedB': 'Units of B without a counterpart in A above the similarity limit.',
  };
  $('tabnote').textContent = notes[S.tab] +
    (items.length > MAXROWS ? ` Showing the first ${MAXROWS} of ${items.length}; the CSV has all.` : '');
};

const escape = str => str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// mark every token with what it belongs to and write the text with spans
const renderTexts = () => {
  const r = S.result;
  S.texts.forEach((t, side) => renderBox(t, [[side, side === 0 ? 'aStart' : 'bStart', side === 0 ? 'aEnd' : 'bEnd']], r));
};

const renderBox = (t, sides, r) => {
  {
    const n = t.display.length;
    const kind = new Uint8Array(n); // 0 none, 1 one-to-one, 2 repeated, 3 phrase, 4 unmatched unit
    const owner = new Int32Array(n).fill(-1);
    const mark = (s, e, k, id) => {
      for(let i = s; i < e && i < n; i++) if(kind[i] === 0) { kind[i] = k; owner[i] = id; }
    };
    for(const [side, startKey, endKey] of sides) {
      for(const p of r.passages) if(p.type === 'one-to-one') mark(p[startKey], p[endKey], 1, p.id);
      for(const p of r.passages) if(p.type !== 'one-to-one') mark(p[startKey], p[endKey], 2, p.id);
      for(const ph of r.phrases) for(const [s, e] of (side === 0 ? ph.a : ph.b)) mark(s, e, 3, ph.id);
    }
    const html = [];
    const spanStarts = [];
    let i = 0;
    while(i < n) {
      let j = i + 1;
      while(j < n && kind[j] === kind[i] && owner[j] === owner[i]) j++;
      const text = escape(t.display.slice(i, j).join(''));
      if(kind[i] === 0) html.push(`<span data-t="${i}">${text}</span>`);
      else html.push(`<span data-t="${i}" data-k="${kind[i]}" data-id="${owner[i]}" class="${['', 'm1', 'mr', 'mp'][kind[i]]}">${text}</span>`);
      spanStarts.push(i);
      i = j;
    }
    t.box.innerHTML = html.join('');
    t.spans = [...t.box.children];
    t.spanStarts = spanStarts;
  }
};

// ---------- showing a match ----------

const spanIndexAt = (t, tok) => {
  let lo = 0, hi = t.spanStarts.length - 1, ans = 0;
  while(lo <= hi) {
    const mid = (lo + hi) >> 1;
    if(t.spanStarts[mid] <= tok) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
};

const flashed = [];
const reveal = (t, s, e) => {
  if(!t.spans) return;
  const first = spanIndexAt(t, s), last = spanIndexAt(t, Math.max(s, e - 1));
  for(let k = first; k <= last && k < first + 400; k++) {
    t.spans[k].classList.add('flash');
    flashed.push(t.spans[k]);
  }
  const el = t.spans[first];
  t.box.scrollTop = Math.max(0, el.offsetTop - t.box.clientHeight / 3);
};
const clearFlash = () => { while(flashed.length) flashed.pop().classList.remove('flash'); };

const showItem = (tab, item) => {
  clearFlash();
  const [A, B] = S.texts;
  if(tab === 'unmatchedA') return reveal(A, item[0], item[1]);
  if(tab === 'unmatchedB') return reveal(B, item[0], item[1]);
  if(tab === 'phrases') {
    reveal(A, ...item.a[0]);
    reveal(B, ...item.b[0]);
    S.cycle = {key: 'phrase' + item.id, k: 0};
    status(`Recurring phrase: ${item.a.length}× in A, ${item.b.length}× in B. Click it in either text to step through its places.`);
    return;
  }
  reveal(A, item.aStart, item.aEnd);
  reveal(B, item.bStart, item.bEnd);
  const la = A.loc(item.aStart), lb = B.loc(item.bStart);
  status(`${item.type}: A ${la.ref || ''} (line ${la.line}) ↔ B ${lb.ref || ''} (line ${lb.line}), similarity ${Math.round(item.similarity * 100)}%.`);
};

// a click on a highlighted piece of text
const clickText = side => e => {
  const span = e.target.closest('span[data-k]');
  if(!span || !S.result) return;
  const kind = +span.dataset.k, id = +span.dataset.id, tok = +span.dataset.t;
  const r = S.result;
  const [startKey, endKey] = side === 0 ? ['aStart', 'aEnd'] : ['bStart', 'bEnd'];
  if(kind === 3) {
    // step through the places of the phrase in the other text
    const ph = r.phrases.find(x => x.id === id);
    const other = side === 0 ? ph.b : ph.a;
    const key = 'phrase' + id;
    const k = S.cycle.key === key ? (S.cycle.k + 1) % other.length : 0;
    S.cycle = {key, k};
    clearFlash();
    reveal(S.texts[side], ...(side === 0 ? ph.a : ph.b).find(([s, e]) => s <= tok && tok < e) || [tok, tok + 1]);
    reveal(S.texts[1 - side], ...other[k]);
    status(`Recurring phrase: place ${k + 1} of ${other.length} in ${side === 0 ? 'B' : 'A'}. Click again for the next one.`);
    return;
  }
  // all passages covering this token; repeated clicks step through them
  const here = r.passages.filter(p => p[startKey] <= tok && tok < p[endKey]);
  if(here.length === 0) return;
  const key = side + ':' + here.map(p => p.id).join(',');
  const k = S.cycle.key === key ? (S.cycle.k + 1) % here.length : 0;
  S.cycle = {key, k};
  showItem(here[k].type, here[k]);
  if(here.length > 1) $('status').textContent += ` (Match ${k + 1} of ${here.length} here; click again for the next.)`;
};

// ---------- CSV ----------

const download = () => {
  if(!S.result) return;
  const [A, B] = S.texts;
  const flat = s => s.replace(/\s+/g, ' ').trim();
  const rows = [['kind', 'ref_A', 'line_A', 'text_A', 'ref_B', 'line_B', 'text_B',
                 'similarity_percent', 'places_in_A', 'places_in_B']];
  for(const p of S.result.passages) {
    const la = A.loc(p.aStart), lb = B.loc(p.bStart);
    rows.push([p.type, la.ref, la.line, flat(textOf(A, p.aStart, p.aEnd)),
               lb.ref, lb.line, flat(textOf(B, p.bStart, p.bEnd)),
               Math.round(p.similarity * 100), p.placesInA, p.placesInB]);
  }
  for(const ph of S.result.phrases) {
    rows.push(['recurring phrase',
      refList(A, ph.a).join('; '), ph.a.map(([s]) => A.loc(s).line).join('; '), flat(mostCommon(A, ph.a)),
      refList(B, ph.b).join('; '), ph.b.map(([s]) => B.loc(s).line).join('; '), flat(mostCommon(B, ph.b)),
      '', ph.a.length, ph.b.length]);
  }
  for(const [units, t, kind, side] of [[S.result.unmatchedA, A, 'no match (unit of A)', 0],
                                       [S.result.unmatchedB, B, 'no match (unit of B)', 1]]) {
    for(const [s, e] of units || []) {
      const l = t.loc(s), text = flat(textOf(t, s, e));
      rows.push(side === 0 ? [kind, l.ref, l.line, text, '', '', '', '', '', '']
                           : [kind, '', '', '', l.ref, l.line, text, '', '', '']);
    }
  }
  const blob = new Blob([toCSV(rows)], {type: 'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `parallels-${textName(0)}-${textName(1)}.csv`.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- setup ----------

populateFilters(document);
// Sanskrit normalization on by default (click it as a person would)
if(!$('check_sanskrit').checked) $('check_sanskrit').click();

$('refpattern').value = '';
$('refpattern').placeholder = 'chosen for each text';
$('ignorepattern').value = IGNORE;
$('refpreset').addEventListener('change', () => {
  const v = $('refpreset').value;
  if(v === 'auto') $('refpattern').value = '';
  else if(v !== 'custom') $('refpattern').value = REFS[v];
});
$('refpattern').addEventListener('input', () => { $('refpreset').value = 'custom'; });
$('unitpreset').addEventListener('change', () => {
  if($('unitpreset').value !== 'custom') $('unitpattern').value = $('unitpreset').value;
});
$('unitpattern').addEventListener('input', () => { $('unitpreset').value = 'custom'; });
$('preset').addEventListener('change', applyPreset);
for(const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener('change', showMode);
for(const input of document.querySelectorAll('input.fileinput')) input.addEventListener('change', loadFile);
$('textA').addEventListener('click', clickText(0));
$('textB').addEventListener('click', clickText(1));
$('textB').addEventListener('input', () => { delete $('textB').dataset.copyOfA; });
$('run').addEventListener('click', run);
$('download').addEventListener('click', download);
applyPreset();

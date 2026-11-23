// Shared by fuzzymatching.html and parallels.html: the normalization
// options and the preparation of a text for n-gram matching.
import { tokenize, detectScript, toewts, totib } from '../lib/tokenize.mjs';
import { filters as normFilters, filterAll, unfilterAll } from '../lib/normalize.mjs';
import transgeez from '../lib/geez.mjs';
import Sanscript from '../lib/sanscript.mjs';

const checkAll = e => {
  const details = e.target.parentNode.querySelector('details');
  if(!details) return;
  
  details.open = true;
  const kids = details.querySelectorAll('input');
  for(const kid of kids) {
    if(kid.dataset.default === 'off')
      continue;
    else
      kid.checked = e.target.checked;
  }
};

const checkFilterBox = e => {
  if(e.target.tagName !== 'INPUT') return;
  const par = e.target.closest('details');
  const parbox = par.parentNode.querySelector('input');
  let checked = null;
  let unchecked = null;
  for(const box of par.querySelectorAll('input')) {
    if(box.checked)
      checked = true;
    else unchecked = true;
    if(checked === true && unchecked === true) {
      parbox.indeterminate = true;
      return;
    }
  }
  if(checked) parbox.checked = true;
  else parbox.checked = false;
  parbox.indeterminate = false;
};

const makeOption = (index,obj) => {
  const div = document.createElement('div');
  const box = document.createElement('input');
  box.setAttribute('type','checkbox');
  box.id = `checkbox_${Date.now() + Math.random()}`;
  box.value = index;
  if(obj.hasOwnProperty('checked')) {
    if(obj.checked === true) box.setAttribute('checked',true);
    else box.dataset.default = 'off';
  }
  const label = document.createElement('label');
  label.setAttribute('for',box.id);
  if(obj.search && obj.replace)
    label.title = `Search: ${obj.search} Replace: ${obj.replace.toString()}`;
  label.append(obj.name);
  div.appendChild(box);
  div.appendChild(label);
  return div;
};

export const populateFilters = par => {
  const normies = par.querySelector('#normalization');

  for(const checkbox of normies.querySelectorAll('input'))
    checkbox.addEventListener('click',checkAll);

  const langMap = new Map();
  for(const lang of ['tamil','sanskrit','pali','geez']) {
    const deets = normies.querySelector(`details.${lang}`);
    deets.addEventListener('click',checkFilterBox);
    langMap.set(lang, deets);
  }
  for(const [i, filter] of normFilters.entries()) {
    if(filter.group === 'general')
      normies.insertBefore(makeOption(i,filter),langMap.get('tamil').parentNode);
    else if(filter.group) {
      const deets = langMap.get(filter.group);
      if(deets) deets.appendChild(makeOption(i,filter));
      else normies.insertBefore(makeOption(i,filter),langMap.get('tamil').parentNode); // catch typos
    }
    else langMap.get('sanskrit').appendChild(makeOption(i,filter));
  }
};

export const getMethod = () => {
  for(const input of document.querySelectorAll('input[name="tokenization"]'))
    if(input.checked) return input.value;
};

export const getFilterIndices = norm => {
    const ret = [];
    const par = norm.querySelector('#normalization');
    for(const box of par.querySelectorAll('input:checked')) {
        const i = parseInt(box.value);
        if(isNaN(i)) continue;
        ret.push([i,box.nextElementSibling.textContent]);
    }
    ret.sort((a,b) => a[0] - b[0]);
    //return [ret.map(r => r[0]), ret.map(r => r[1])];
    return ret.reduce((acc,cur) => {
        acc[0].push(cur[0]);
        acc[1].push(cur[1]);
        return acc;
    },[[],[]]);
};

export const shouldTransliterate = (filternames, method) => {
  if(['aksara','eluttu','char'].includes(method)) return true;
  for(const name of filternames) {
    if(!['ignore punctuation','remove spaces','ignore vowels'].includes(name))
      return true;
  }
  return false;
};


// The script most letters of the text are written in. detectScript() takes
// the first script of which it finds any character at all, so a few stray
// characters (common in OCR) would make a whole romanized text count as
// Bengali or Tibetan.
const SCRIPTS = [
  ['tamil', /[\u0b80-\u0bff]/gu],
  ['devanagari', /[\u0900-\u0963\u0966-\u097f]/gu], // not the daṇḍas, used with any script
  ['bengali', /[\u0980-\u09ff]/gu],
  ['burmese', /[\u1000-\u109f]/gu],
  ['sinhala', /[\u0d80-\u0dff]/gu],
  ['telugu', /[\u0c00-\u0c7f]/gu],
  ['malayalam', /[\u0d00-\u0d7f]/gu],
  ['sarada', /[𑆃-𑆲]/gu],
  ['grantha', /[𑌅-𑌹]/gu],
  ['newa', /[𑐀-𑐴]/gu],
  ['tibetan', /[ༀ-࿚]/gu],
  ['geez', /[\u1200-\u137f]/gu],
  ['iast', /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/gu],
];
export const mainScript = str => {
  let best = 'iast', most = 0;
  for(const [name, re] of SCRIPTS) {
    const count = (str.match(re) || []).length;
    if(count > most) { best = name; most = count; }
  }
  return most > 0 ? best : detectScript(str);
};

/*
 * Prepares one text for n-gram matching.
 * Returns
 *   display: the tokens as they are shown (pieces of the original text where possible)
 *   keys:    the tokens as they are compared
 * Characters matched by `ignore` (a regular expression with the g flag) are
 * replaced by spaces before comparing, so that markup is not matched.
 */
export const prepareText = (orig, method, filterindices, filternames, ignore) => {
  let source = ignore ? orig.replaceAll(ignore, m => m.replaceAll(/[^\n]/g,' ')) : orig;
  let trans, scheme, script;
  if(shouldTransliterate(filternames, method)) {
    const detected = mainScript(source);
    if(detected === 'geez') trans = transgeez(source);
    else if(detected === 'tibetan') {
      trans = Sanscript.t(toewts(source),'wylie','wylish');
      scheme = 'wylish';
      script = 'tibetan';
    }
    else {
      // In the internal scheme capitals stand for aspirates (K = kh), so
      // capitals in an IAST text ("The", "Caraka") would be misread.
      // Compare in lowercase; the original text is shown again below.
      // Sanscript also treats "##" as a switch that turns transliteration
      // off and on and drops it, so # is replaced by a private-use
      // character of the same length while comparing.
      source = (detected === 'iast' ? source.toLowerCase() : source).replaceAll('#','');
      trans = Sanscript.t(source, detected, 'slpish');
      scheme = 'slpish';
      script = detected;
    }
  }
  const [filtered,filters] = filterAll(trans || source, filterindices);
  // The shared whitespace tokenizer turns every run of whitespace into one
  // space, so its tokens no longer add up to the text and restoring the
  // unnormalized text fails (or crashes on texts with tabs and line breaks).
  // Here each token keeps its own whitespace exactly.
  const tokenized = method === 'whitespace' ?
    (filtered.match(/^\s+|\S+\s*/gu) || []) :
    tokenize(filtered,method,{removespaces: false, script: script});
  let display = unfilterAll(tokenized, filters);
  if(scheme) {
    const toOrig = i => {
      if(scheme === 'wylish') {
        if(method === 'aksara') return totib(Sanscript.t(i,'wylish','wylie'));
        else return Sanscript.t(i,'wylish','wylie');
      }
      const iast = Sanscript.t(i,'slpish','iast');
      return script && method !== 'char' ? Sanscript.t(iast,'iast',script) : iast;
    };
    // the same tokens recur many times, so convert each distinct one only once
    const cache = new Map();
    display = display.map(i => {
      let out = cache.get(i);
      if(out === undefined) {
        out = toOrig(i);
        cache.set(i,out);
      }
      return out;
    });
  }
  // If the tokens give back exactly the text that was compared, show the
  // corresponding pieces of the original text, with its capitals and markup.
  if(source !== orig && source.length === orig.length && display.join('') === source) {
    let start = 0;
    display = display.map(t => {
      const piece = orig.slice(start, start + t.length);
      start = start + t.length;
      return piece;
    });
  }
  // a line break or tab should not prevent a match where the other text has a space
  const keys = method === 'whitespace' ?
    tokenized.map(t => t.trim() + ' ') :
    tokenized.map(t => t.replace(/\s+/gu,' '));
  return {display, keys};
};

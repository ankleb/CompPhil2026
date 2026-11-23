import { ngramswithindices } from '../lib/ngrams.mjs';
import { populateFilters, getMethod, getFilterIndices, prepareText } from './prepare.mjs';

const addIndices = (is,ngramsize,iset) => {
  for(const i of is) {
    for(let n=0;n<ngramsize;n++) {
      iset.add(i + n);
    }
  }
};

const submit = () => {
  const inputs = [
    {box: document.getElementById('textinput1')},
    {box: document.getElementById('textinput2')}
  ];
  const ngramsize = document.getElementById('ngramsize').value;
  const method = getMethod();
  const [filterindices, filternames] = getFilterIndices(document);
  for(const input of inputs) {
    const orig = input.box.textContent.trim();
    const {display, keys} = prepareText(orig, method, filterindices, filternames);
    input.unfiltered = display;
    input.ngrams = ngramswithindices(keys, ngramsize);
  }
  inputs[0].highlight = new Set();
  inputs[1].highlight = new Set();
  for(const gram of inputs[0].ngrams.keys()) {
    if(inputs[1].ngrams.has(gram)) {
      const indices1 = inputs[0].ngrams.get(gram).indices;
      addIndices(indices1,ngramsize,inputs[0].highlight); 
      const indices2 = inputs[1].ngrams.get(gram).indices;
      addIndices(indices2,ngramsize,inputs[1].highlight); 
    }
  }
  // the texts may contain <, > or &, which must not be read as HTML
  const escape = str => str.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  for(const input of inputs) {
    const html = [];
    for(let n=0;n < input.unfiltered.length; n++) {
      if(input.highlight.has(n))
        html.push(`<span class="highlight">${escape(input.unfiltered[n])}</span>`);
      else
        html.push(escape(input.unfiltered[n]));
    }
    input.box.innerHTML = html.join('');
  }
};

const removeHighlights = () => {
  for(const span of document.querySelectorAll('.inputbox span.highlight')) {
    while(span.firstChild)
      span.after(span.firstChild);
    span.remove();
  }
};

const loadSamples = e => {
  const par = e.target.closest('.samplebox');
  if(!par) return;
  const boxen = [...document.querySelectorAll('.inputbox')];
  const existing = boxen[0].textContent.trim() !== '' || boxen[1].textContent.trim() !== '';
  if(existing && !window.confirm('Replace existing texts?')) return;
  boxen[0].textContent = par.querySelector('.sample1').textContent.trim();
  boxen[1].textContent = par.querySelector('.sample2').textContent.trim();
};

const loadFile = async e => {
  const file = e.target.files[0];
  if(!file) return;
  const box = document.getElementById(e.target.dataset.target);
  if(box.textContent.trim() !== '' && !window.confirm('Replace the existing text?')) {
    e.target.value = '';
    return;
  }
  const text = await file.text();
  box.textContent = text.replace(/^\uFEFF/,''); // drop a byte order mark
  e.target.value = ''; // so that the same file can be loaded again
};

for(const input of document.querySelectorAll('input.fileinput'))
  input.addEventListener('change',loadFile);
document.getElementById('samples').addEventListener('click',loadSamples);
document.getElementById('comparesubmit').addEventListener('click',submit);
for(const input of document.querySelectorAll('.inputbox'))
  input.addEventListener('input',removeHighlights);
populateFilters(document);

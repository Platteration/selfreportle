const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const T = require('../lib/text-analyzer.js');
const S = require('../lib/signals.js');
const A = require('../lib/attribution.js');
const R = require('../lib/research.js');
const C = require('../lib/model-catalog.js');
const I = require('../lib/image-hints.js');
const M = require('../lib/image-metadata.js');
const V = require('../lib/verdicts.js');
const H = require('./helpers.js');

const analysed = (text, options) => {
  const r = T.analyzeText(text, options);
  return { ...r, attribution: A.attributeText({ ...r, page: { signals: r.signals } }) };
};

test('one ordinary vocabulary word cannot accuse a human writer or identify a vendor', () => {
  const museum = 'This tapestry was woven by hand for the local museum. The label explains where the wool came from and how the colours were mixed. Visitors can see the original repairs along the edge. A volunteer wrote the description after speaking to the family who donated it many years ago in winter.';
  for (const word of ['tapestry', 'delve', 'pivotal', 'intricate', 'showcasing', 'meticulously']) {
    const r = analysed(museum.replace('tapestry', word), { lang: 'en', sensitivity: 'high' });
    assert.equal(r.verdict, 'no-signal', word);
    assert.equal(r.attribution, null, word);
  }
});

test('repeating one research word does not create independent evidence', () => {
  const r = analysed('The author chose the word delve. '.repeat(50), { lang: 'en', sensitivity: 'high' });
  assert.equal(r.verdict, 'no-signal');
  assert.ok(!r.signals.some((s) => s.id === 'research-vocabulary' || s.id === 'lexicon'));
});

test('a small research cluster without corroboration stays below the flag threshold', () => {
  const text = 'The report delves into records showcasing changes and underscoring details. '
    + 'I found the folder yesterday. It had been left in the kitchen drawer where all the old school letters end up, beside the batteries and the broken torch. '
    + 'There were nine pages. Sam read two and put them back. We did not agree on the dates because the ink on the first receipt was faint, so I asked the shop to check its original copy before we wrote anything down.';
  const r = analysed(text, { lang: 'en', sensitivity: 'high' });
  assert.equal(r.verdict, 'no-signal');
  assert.ok(r.score < .22);
  const signal = r.signals.find((s) => s.id === 'research-vocabulary');
  assert.deepEqual(signal.sourceIds, ['excess-vocabulary']);
  assert.equal(signal.patternIds.length, 3);
});

test('corroborated research vocabulary remains a sourced heuristic with an unidentified model', () => {
  const text = 'The study delves into intricate results, showcasing noteworthy details that bolster nuanced interpretations. '
    + 'The team reviewed the records and described the observations using their usual methods. '.repeat(8);
  const r = analysed(text, { lang: 'en' });
  assert.equal(r.verdict, 'likely-ai');
  assert.ok(r.score < .75);
  assert.equal(r.attribution.id, null);
  assert.equal(r.attribution.confidence, 'unknown');
  const signal = r.signals.find((s) => s.id === 'research-vocabulary');
  assert.match(signal.detail, /not proof/);
  assert.equal(signal.patternCount, 6);
  for (const id of signal.sourceIds) assert.ok(R.SOURCES[id].scope && R.SOURCES[id].limitation && R.SOURCES[id].url);
});

test('generic markup, closing phrases and typography share the heuristic cap', () => {
  const normalReadme = '# Installing the tool\nUse **the stable version** for local work.\n```sh\nnpm install\n```\n'
    + 'The script prints the version and then closes the connection. Please check the path before you run the command on another computer. I hope this helps. ';
  const plain = analysed(normalReadme, { lang: 'en', sensitivity: 'high' });
  assert.equal(plain.verdict, 'no-signal');
  const cluster = 'The study delves into intricate results, showcasing noteworthy details that bolster nuanced interpretations. '
    + 'The team reviewed the records and described the observations using their usual methods. '.repeat(8);
  const r = analysed(normalReadme + cluster + '\u202f'.repeat(7), { lang: 'en', sensitivity: 'high' });
  assert.ok(r.score <= .55, 'soft signals must not bypass their shared cap');
  assert.notEqual(r.verdict, 'ai');
});

test('new model declarations are detected and attributed from explicit wording', () => {
  for (const [name, id] of [
    ['Google Gemma 3', 'gemma'], ['Microsoft Phi-4', 'phi'], ['Cohere Command R', 'cohere'],
    ['AI21 Jamba', 'ai21'], ['IBM Granite 3.1', 'granite'], ['OLMo2', 'olmo'], ['Kimi-K2', 'kimi'],
    ['MiniMax-M1', 'minimax'], ['GLM-4', 'glm'], ['InternLM3', 'internlm'], ['Yi-1.5', 'yi'],
    ['Baichuan2', 'baichuan'], ['Qwen3', 'alibaba'], ['Llama 3.1', 'meta'], ['Mixtral', 'mistral'],
    ['Codestral', 'mistral'], ['gpt-oss-20b', 'openai'],
  ]) {
    const r = analysed('This summary was generated by ' + name + '.');
    assert.equal(r.verdict, 'ai-disclosed', name);
    assert.equal(r.attribution.id, id, name);
    assert.equal(r.attribution.confidence, 'declared', name);
    assert.equal(analysed('This summary was written with the help of ' + name + '.').verdict, 'ai-assisted-disclosed', name);
  }
});

test('the new model vocabulary works in every existing disclosure language', () => {
  for (const [lang, text, id] of [
    ['de', 'Dieser Text wurde erstellt mit Qwen3.', 'alibaba'],
    ['fr', 'Texte généré par Google Gemma 3.', 'gemma'],
    ['es', 'Texto generado con IBM Granite 3.1.', 'granite'],
    ['nl', 'Tekst gemaakt met Cohere Command R.', 'cohere'],
    ['it', 'Testo generato con GLM-4.', 'glm'],
    ['pt', 'Texto gerado por Kimi-K2.', 'kimi'],
    ['pl', 'Tekst wygenerowany przez Microsoft Phi-4.', 'phi'],
  ]) {
    const r = analysed(text, { lang });
    assert.equal(r.verdict, 'ai-disclosed', lang);
    assert.equal(r.attribution.id, id, lang);
  }
});

test('negation and human names are not declarations of AI use', () => {
  assert.equal(analysed('This article was not generated by AI. Every word is 100% human-written.').verdict, 'human-disclosed');
  for (const text of [
    'This article was not generated by Qwen3.', 'This note was never written using IBM Granite 3.1.',
    'This letter was written by Claude Monet to a friend in Paris.',
    'This story was written by Jasper Jones after his trip.',
    'This image was created by Sora Tanaka in her studio.',
    'This article compares Gemma, Phi, granite countertops and the mathematical minimax algorithm.',
  ]) {
    const r = analysed(text);
    assert.equal(r.verdict, 'no-signal', text);
    assert.equal(r.attribution, null, text);
  }
  for (const suffix of ['Sonnet', 'API', 'Desktop', 'Pro', 'Max', 'Team', 'Enterprise']) {
    assert.equal(analysed('This summary was generated by Claude ' + suffix + '.').attribution.id, 'anthropic', suffix);
  }
});

const FORMATS = [
  ['meta', '<|start_header_id|>assistant<|end_header_id|>\nAn answer.<|eot_id|>'],
  ['gemma', '<start_of_turn>model\nAn answer.<end_of_turn>'],
  ['openai', '<|start|>assistant<|channel|>final<|message|>An answer.<|return|>'],
  ['minimax', '<beginning_of_sentence>ai name=assistant\nAn answer.<end_of_sentence>'],
  ['kimi', '<|tool_calls_section_begin|><|tool_call_begin|>tool:weather<|tool_call_end|><|tool_calls_section_end|>'],
];
test('paired documented format markers infer compatibility without certifying authorship', () => {
  for (const [id, text] of FORMATS) {
    const r = analysed(text);
    const signal = r.signals.find((s) => s.id === 'model-artifact');
    assert.equal(signal.toolId, id);
    assert.ok(signal.patternIds.length && signal.sourceUrls[0].startsWith('https://github.com/'));
    assert.equal(r.attribution.id, id);
    assert.equal(r.attribution.confidence, 'inferred');
    assert.notEqual(r.verdict, 'ai', 'a copied format alone cannot prove AI authorship');
  }
});

test('incomplete, shared role and reasoning tokens do not identify a specific model', () => {
  for (const text of ['<start_of_turn>model', '<|start_header_id|>assistant<|end_header_id|>',
    '<think>I should check the arithmetic.</think>', '<|user|>hello<|assistant|>hello',
    '<|im_start|>user\nhello<|im_end|><|im_start|>assistant\nhello<|im_end|>']) {
    const r = analysed(text);
    assert.equal(r.verdict, 'no-signal', text);
    assert.equal(r.attribution, null, text);
    assert.ok(r.signals.every((s) => !s.toolId));
  }
});

test('new media names require generation evidence rather than an ordinary caption mention', async () => {
  for (const name of ['HunyuanVideo', 'Wan2.1', 'LTX-Video', 'MusicGen', 'ElevenLabs', 'Suno Bark']) {
    assert.ok(!I.analyzeImageHints({ caption: 'A conference slide about ' + name }).some((s) => s.verdict === 'suspected'), name);
    const signals = I.analyzeImageHints({ caption: 'This media was generated by ' + name });
    assert.ok(signals.some((s) => s.id === 'caption-disclosure'), name);
    const bytes = await M.analyzeImageBytes(H.png([H.tEXt('Software', name)]));
    assert.equal(V.combineImageSignals(bytes.signals).verdict, 'ai-generated', name);
  }
  assert.equal(S.GENERATOR_SOFTWARE_RE.test('Qwen3'), false, 'a text model is not an image generator');
  assert.equal(S.GENERATOR_SOFTWARE_RE.test('Qwen-Image'), true);
});

test('all extension script entrypoints include the new dependencies before their consumers', () => {
  const lists = [JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8')).content_scripts[0].js];
  for (const file of ['popup/popup.html', 'publisher/publisher.html']) {
    lists.push([...fs.readFileSync(path.join(__dirname, '..', file), 'utf8').matchAll(/src="\.\.\/(lib\/[^" ]+)"/g)].map((m) => m[1]));
  }
  lists.push([...fs.readFileSync(path.join(__dirname, '../background/service-worker.js'), 'utf8').split('\n').find((s) => s.startsWith('importScripts')).matchAll(/'\.\.\/(lib\/[^']+)'/g)].map((m) => m[1]));
  for (const list of lists) {
    const sandbox = { TextEncoder, TextDecoder, URL };
    vm.createContext(sandbox);
    for (const file of list.filter((s) => s.startsWith('lib/'))) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
    assert.ok(sandbox.SRL.modelCatalog && sandbox.SRL.research && sandbox.SRL.signals);
    assert.ok(sandbox.SRL.signals.findDisclosures('Text generated by IBM Granite 3.1.').some((s) => s.level === 'generated'));
  }
});

test('dynamically assembled disclosure and model patterns remain usable on a capped hostile page', () => {
  const hostile = ('generated by G' + 'p'.repeat(80) + ' not generated with X. ').repeat(2800).slice(0, 300000);
  const start = performance.now();
  for (const lang of [undefined, 'de', 'fr', 'es', 'nl', 'it', 'pt', 'pl']) S.findDisclosures(hostile, { lang });
  T.scanModelArtifacts(hostile);
  for (const model of C.MODELS) model.match.test(hostile);
  assert.ok(performance.now() - start < 4000, 'dynamic patterns must finish within the existing page-analysis budget');
});

test('three-item lists preserve hyphens, apostrophes and the prior non-overlapping counts', () => {
  const previous = /\b[\w'’-]{1,30}, [\w'’-]{1,30}(?: [\w'’-]{1,30})?, (?:and|or) [\w'’-]{1,30}/g;
  for (const text of [
    'clear, bright, and strong', 'co-operation, steady progress, and care',
    "John's, Mary's, or Sam’s", 'red, green, and blue, purple, and orange',
    'red, green, blue', 'one, two words, or three', 'well-made, hand-written, and well-worn',
    'No list here.', "'red', 'green', and 'blue'",
    ...Array.from({ length: 80 }, (_, i) => ('alpha, beta, and gamma. ').repeat(i % 7)),
  ]) assert.equal(T.countTricolons(text), (text.match(previous) || []).length, text);
  assert.equal(T.countTricolons('a-'.repeat(150000)), 0);
});

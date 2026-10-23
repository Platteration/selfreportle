const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../lib/text-analyzer.js');
const A = require('../lib/attribution.js');
const V = require('../lib/verdicts.js');

/*
 * A reply from a current chat assistant read as "no signal" in every path —
 * pasted, saved as a text file, and rendered on a page — because the only
 * evidence that could lift a heuristic past the flag threshold was a 2023
 * word list ("delve", "tapestry") those replies no longer use. The fixtures
 * under fixtures/chat/ are four such replies, verbatim, from two assistants:
 * each scored no-signal before the reply's shape (register, bold lead-ins,
 * transcript labels, an answer addressed to "you") was read.
 *
 * The other half of this file is the people who write the same phrases: a
 * support e-mail closes "Hope this helps", a tutor opens "Good question",
 * documentation introduces its examples "Here's an example:". None of them
 * may be flagged.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'chat');
const replies = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.md')).sort();
const read = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const flagged = (v) => V.AI_TEXT_VERDICTS.has(v);
const analysed = (text, options) => {
  const r = T.analyzeText(text, options);
  return { ...r, attribution: A.attributeText({ ...r, page: { signals: r.signals } }) };
};

/* What a page gives the analyser once the reply is rendered: the markdown gone, one block per
 * paragraph or list item, blocks of under eight words left out, and the count of blocks that
 * opened with a bold label (content/content.js's opensWithBold). */
function rendered(md) {
  let boldLeads = 0;
  const blocks = [];
  for (const line of md.split('\n')) {
    const item = line.replace(/^\s*(?:#{1,6}|[-*•]|\d+\.)\s+/, '');
    if (/^\*\*[^*]{1,80}\*\*/.test(item) && !/^\s*#/.test(line)) boldLeads++;
    const text = item.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();
    if (text && text !== '---' && T.countWords(text) >= 8) blocks.push(text);
  }
  return { text: blocks.join('\n\n'), boldLeads };
}

test('four real assistant replies are flagged pasted and rendered, as a heuristic and no more', () => {
  assert.equal(replies.length, 4);
  for (const f of replies) {
    const pasted = analysed(read(f), { lang: 'en' });
    assert.ok(flagged(pasted.verdict), f + ' pasted: ' + pasted.verdict + ' ' + pasted.score);
    assert.notEqual(pasted.verdict, 'ai', f + ': wording and layout never reach the strongest verdict');
    assert.equal(pasted.attribution.id, null, f + ': and name no vendor');
    const page = rendered(read(f));
    const r = T.analyzeText(page.text, { lang: 'en', mode: 'page', boldLeads: page.boldLeads });
    assert.ok(flagged(r.verdict), f + ' rendered: ' + r.verdict + ' ' + r.score);
    assert.ok(r.signals.some((s) => s.id === 'bold-lead-ins'), f + ': the page\'s count is what stands in for the markdown');
  }
});

test('a rendered reply without the page\'s count of bold labels is not flagged by its words alone', () => {
  // The count is the evidence the rendering took away; without it the
  // shorter Gemini reply has one register part and nothing to anchor it.
  const page = rendered(read('gemini-roth-ira.md'));
  assert.equal(T.analyzeText(page.text, { lang: 'en', mode: 'page' }).verdict, 'no-signal');
  assert.ok(flagged(T.analyzeText(page.text, { lang: 'en', mode: 'page', boldLeads: page.boldLeads }).verdict));
});

test('the bold-label count is read in whole-page mode only, and never weighed twice', () => {
  const md = read('claude-raise-email.md');
  const block = T.analyzeText(md, { lang: 'en', mode: 'block', boldLeads: 50 });
  const plain = T.analyzeText(md, { lang: 'en', mode: 'block' });
  assert.equal(block.score, plain.score, 'a block is one paragraph; the page count is not its');
  // Literal markdown and a caller's count are the same labels: one signal, one weight.
  const page = T.analyzeText(md, { lang: 'en', mode: 'page', boldLeads: 50 });
  assert.equal(page.signals.filter((s) => s.id === 'markdown-leak' || s.id === 'bold-lead-ins').length, 1);
  assert.equal(page.signals.find((s) => s.id === 'markdown-leak').weight, 0.12);
  // A count that is not a number counts nothing.
  for (const boldLeads of ['many', -4, NaN, {}]) {
    assert.ok(!T.analyzeText('A reply. '.repeat(30), { mode: 'page', boldLeads }).signals.some((s) => s.id === 'bold-lead-ins'), String(boldLeads));
  }
});

test('a chat page\'s turn label is hard evidence and names the assistant; a person\'s name alone is not', () => {
  const chatgpt = analysed('You said:\nhow do i stop my cat scratching the couch\n\nChatGPT said:\nCats scratch to sharpen their claws, so give them a post.');
  assert.equal(chatgpt.verdict, 'ai');
  assert.equal(chatgpt.signals.find((s) => s.id === 'transcript-label').toolId, 'openai');
  assert.equal(chatgpt.attribution.id, 'openai');
  assert.equal(chatgpt.attribution.confidence, 'inferred');
  // The share page's visually hidden heading, read as a block of its own.
  assert.equal(T.analyzeText('ChatGPT said:').verdict, 'ai');
  // Claude, Gemini and Grok are names people and things have: only beside the user's label.
  for (const name of ['Claude', 'Gemini', 'Grok']) {
    assert.equal(T.analyzeText(name + ' said:\nThe garden needs rain before the weekend, and so do we.').verdict, 'no-signal', name);
    const pair = analysed('You said:\nwhat should I plant\n\n' + name + ' said:\nTry beans; they are forgiving.');
    assert.equal(pair.verdict, 'ai', name + ' beside "You said:"');
    assert.ok(pair.attribution.id, name + ' is attributed');
  }
  // A label is a line of its own, not a phrase in a sentence.
  assert.equal(T.analyzeText('My colleague told me ChatGPT said: no. I did not believe it.').verdict, 'no-signal');
  assert.equal(T.analyzeText('chatgpt said:').verdict, 'no-signal', 'the label is written the way the page writes it');
});

/* Written in the shape of real correspondence, each using the phrases a reply's register is
 * made of: openers ("Good question", "You're right"), offers ("Would you like me to", "If you
 * tell me … I can", "Happy to look"), sign-offs ("Hope this helps!"). */
const PEOPLE = {
  'support e-mail': `Hi Mark,

Thanks for getting back to me so quickly. I had a look at the invoice and you're right, we charged you twice for the March delivery. Sorry about that - our billing system had a hiccup that week and a few customers got caught by it.

I've put the refund through this morning, it should show on your card in 3-5 working days depending on your bank. If it hasn't turned up by next Friday just reply to this email and I'll chase it with accounts.

Would you like me to set up the April order the same as last time? Same quantities, same drop-off at the back door?

Hope this helps, and sorry again for the hassle.

Cheers,
Dave`,
  'forum answer': `Good question. I had exactly the same problem with my old Bosch and it turned out to be the drain pump filter, not the pump itself.

On most models there's a little flap at the bottom right of the front panel. Put a towel and a baking tray down first because a LOT of water comes out. Unscrew the filter anticlockwise, and you'll probably find a sock, some hair and a couple of coins in there. Mine had a hair grip wedged across the impeller which is why it was making that grinding noise.

If that doesn't sort it, check the hose at the back isn't kinked where it goes behind the units. After that it's probably the pump and they're about 30 quid on ebay, pretty easy swap with a screwdriver.

Hope this helps! Let me know how you get on.`,
  'shop reply': `Hello! Thank you so much for your order, it's on the cutting table today.

The linen in the photo is the oatmeal colour, but I also have it in sage and a darker charcoal if you'd prefer something that hides marks better. If you tell me the window width I can work out how many panels you'll need, most people underestimate and the curtains end up looking a bit flat.

I'm happy to send a swatch first if you're unsure, it's no trouble at all. Just let me know!

Warmly,
Jo`,
  'mentor e-mail': `Hi Sam,

Great question, and I'm glad you asked rather than just guessing.

The short answer is no, you don't need to redo the whole analysis. The reviewer's point is really about the outliers in figure 3. If you rerun that one model with and without the three flagged participants and report both, that should satisfy them. Put the second version in the supplement.

On the wider question of whether to switch to a mixed model - I'd hold off. It's a bigger change than it looks and it'll open up a new round of comments. Maybe for the next paper.

Happy to look at the response letter before you send it if that's useful. Just drop it in the shared folder.

Best,
Helen`,
  'tutor note': `Hi Aisha,

You're right that the textbook explanation is confusing! Here's how I'd think about it.

When you divide by a fraction you're really asking "how many of these fit into that?" So 3 divided by a half is asking how many halves fit into 3. Six. That's why the answer gets bigger, which feels wrong at first.

The "flip and multiply" rule is just a shortcut for that. Try a few with pictures first - draw 3 pizzas and cut them in halves - and the rule will start to make sense on its own.

Have a go at questions 4 to 10 on page 52 and bring them on Tuesday. If you get stuck on any, send me a message and I can go through it.

See you Tuesday!
Mr Okafor`,
};

test('people who write a reply\'s phrases are not flagged, pasted or as a page, at any sensitivity', () => {
  for (const [what, text] of Object.entries(PEOPLE)) {
    for (const sensitivity of ['low', 'medium', 'high']) {
      for (const mode of ['block', 'page']) {
        const r = analysed(text, { lang: 'en', sensitivity, mode, boldLeads: 0 });
        assert.equal(r.verdict, 'no-signal', what + ' (' + sensitivity + ', ' + mode + '): ' + r.signals.map((s) => s.id + ' ' + s.weight).join(', '));
      }
    }
  }
});

test('documentation that introduces its examples under bold labels is not a reply', () => {
  const readme = `# Options

Here's an example:

\`\`\`js
serve({ public: 'dist' });
\`\`\`

- **public:** the folder to serve. Defaults to the current directory.
- **cleanUrls:** strip the .html extension from paths.
- **rewrites:** an array of rewrite rules, checked in order.
- **headers:** extra response headers per path pattern.
- **etag:** send an ETag header instead of Last-Modified.

Here are a few highlights of what you can configure:

**Redirects** are matched before rewrites, and the first match wins. **Trailing slashes** can be forced on or off for every path. The configuration is read once at start-up, so restart the server after you change it.`;
  for (const sensitivity of ['medium', 'high']) {
    const r = analysed(readme, { lang: 'en', sensitivity });
    assert.equal(r.verdict, 'no-signal', sensitivity + ': ' + r.signals.map((s) => s.id + ' ' + s.weight).join(', '));
  }
  // The same page announcing a prepared answer is the other shape.
  const announced = readme.replace("Here's an example:", "Here's a step-by-step guide:");
  assert.ok(flagged(T.analyzeText(announced, { lang: 'en' }).verdict));
  // But not under fewer than five bold labels.
  assert.equal(T.analyzeText(announced.replace(/- \*\*(etag|headers):\*\*/g, '- $1:'), { lang: 'en' }).verdict, 'no-signal');
});

test('one part of the register alone stays below the flag; all three alone give a weak flag and never more', () => {
  const body = 'The bus to the coast leaves from the square every hour, and the last one back is at nine in the evening. '
    + 'Tickets are cheaper if you buy them from the machine before you get on, and children under five ride for free all year. ';
  const offer = body + '\n\nWould you like me to check the Sunday timetable as well?';
  assert.equal(T.analyzeText(offer, { lang: 'en', sensitivity: 'high' }).verdict, 'no-signal');
  const whole = 'Great question! ' + body + '\n\nHere is a quick overview of the fares:\n\n' + body + '\n\nWould you like me to check the Sunday timetable as well?';
  for (const sensitivity of ['medium', 'high']) {
    const r = T.analyzeText(whole, { lang: 'en', sensitivity });
    assert.equal(r.verdict, 'possible-ai', sensitivity);
    assert.equal(r.signals.find((s) => s.id === 'chat-register').parts, 3);
  }
});

test('a non-English page keeps its own closing-phrase check and is not read for the English register', () => {
  const de = 'Die Bäckerei öffnet um sieben Uhr und schließt am Nachmittag, außer am Sonntag, wenn sie geschlossen bleibt. '.repeat(3)
    + 'Ich hoffe, das hilft.';
  const r = T.analyzeText(de, { lang: 'de' });
  assert.ok(r.signals.some((s) => s.id === 'self-reference-weak'));
  assert.ok(!r.signals.some((s) => s.id === 'chat-register'));
});

test('"it isn\'t X. It\'s Y" reframes are noted as one kind of move, and on their own stay below the flag', () => {
  const essay = 'The question of whether cities should ban cars from their centres isn\'t really a question about cars. It\'s a question about what we think streets are for. '
    + 'For most of the last century the answer was obvious, and everything else had to fit in around the traffic that used them. '
    + 'The cost was real even when it was spread thin: noise, dirty air, and children who no longer played outside on the pavement. '
    + 'Cities that closed their centres tell a fairly consistent story about what happened to the shops and the people who lived there. '
    + 'It\'s not a universal fix, though. It\'s a choice that only works where the buses and bicycles are already good enough to carry everyone.';
  const r = T.analyzeText(essay, { lang: 'en', sensitivity: 'high' });
  const rhetoric = r.signals.find((s) => s.id === 'rhetoric');
  assert.ok(rhetoric, 'two reframes in a short essay are noted');
  assert.match(rhetoric.detail, /^2 in \d+ words, 1 kind: /);
  assert.equal(rhetoric.forms, 1, 'variants of one move are one habit');
  assert.equal(r.verdict, 'no-signal', 'a rhetorical habit alone accuses nobody');
});

test('the publisher page lists a chat turn label among the pasted-in leftovers', () => {
  const vm = require('node:vm');
  const element = (tag) => ({ tag, children: [], appendChild(child) { this.children.push(child); }, addEventListener() {} });
  const sandbox = {
    SRL: { verdicts: {}, attribution: {} }, URLSearchParams, location: { search: '' },
    document: { getElementById() { return { addEventListener() {} }; }, createElement: element },
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../publisher/publisher.js'), 'utf8').replace('await load(false);', 'globalThis.describeTextTellsForTest = describeTextTells;');
  vm.runInContext(source, sandbox);
  const r = T.analyzeText('ChatGPT said:');
  const tells = sandbox.describeTextTellsForTest({ verdict: r.verdict, flagged: [{ verdict: r.verdict, signals: r.signals }] });
  assert.match(tells, /^Found on this page: Chat transcript turn labelled as an AI assistant\./);
});

test('a plain explanation that answers "you" under bold labels gives the weak flag; without the labels, nothing', () => {
  // No opener, no offer, no announced answer: only the answer's shape.
  const coffee = read('claude-coffee.md');
  const r = T.analyzeText(coffee, { lang: 'en' });
  assert.equal(r.verdict, 'possible-ai');
  assert.ok(!r.signals.some((s) => s.id === 'chat-register'));
  assert.ok(r.signals.some((s) => s.id === 'addressed-answer'));
  // The same words with the bold taken out: an answer to "you" is what a letter is too.
  const plain = T.analyzeText(coffee.replace(/\*\*/g, ''), { lang: 'en', sensitivity: 'high' });
  assert.equal(plain.verdict, 'no-signal');
  assert.ok(plain.signals.some((s) => s.id === 'addressed-answer'), 'still noted, never enough alone');
});

test('a page that opens with a title is not an answer, however it addresses its reader', () => {
  const body = ['**Cut back the dead wood.** You should remove anything brown or brittle first, so your plant puts its energy into new growth.',
    '**Open up the middle.** You want air to move through the bush, so take out any stems that cross the centre or rub against each other.',
    '**Cut above an outward bud.** Your cut should sit just above a bud that faces out, at a slight angle, so rain runs off it.',
    '**Feed it afterwards.** Once you have finished, give your roses a balanced feed and a thick mulch to keep the roots cool.'].join('\n\n');
  const titled = T.analyzeText('Pruning roses in early spring for a better summer\n\n' + body, { lang: 'en', sensitivity: 'high' });
  assert.equal(titled.verdict, 'no-signal', titled.signals.map((s) => s.id).join(', '));
  assert.ok(!titled.signals.some((s) => s.id === 'addressed-answer'));
  const answered = T.analyzeText('Late winter is the best time, just as the buds start to swell.\n\n' + body, { lang: 'en' });
  assert.equal(answered.verdict, 'possible-ai');
});

test('stacked stock rhetoric anchors; one writer\'s favourite move, however often, does not', () => {
  const post = 'Here\'s the thing about burnout: it\'s not a time problem, it\'s an energy problem. I learned that the hard way last spring, after a year of saying yes to everything. '
    + 'The result? Three months of feeling like a ghost in my own job, answering messages at midnight and remembering none of them. '
    + 'No meetings. No Slack. Just a long walk every morning — and that\'s where the real recovery comes in. '
    + 'Rest is not a reward — it\'s a requirement. Protect it the way you protect your calendar for the people who matter.';
  const r = T.analyzeText(post, { lang: 'en' });
  const rhetoric = r.signals.find((s) => s.id === 'rhetoric');
  assert.ok(rhetoric.forms >= 4, 'reframe, fragment question, negation run, here\'s the thing, comes in: ' + rhetoric.detail);
  assert.equal(r.verdict, 'possible-ai', 'four kinds or more give the weak flag alone, and never more: ' + r.signals.map((s) => s.id).join(', '));
  // Three kinds anchor but need a second family; here, the dashes of a longer post.
  const three = post.replace("Here's the thing about burnout: it's", "Burnout: it's").replace(' — and that\'s where the real recovery comes in', '');
  assert.equal(T.analyzeText(three, { lang: 'en' }).signals.find((s) => s.id === 'rhetoric').forms, 3);
  assert.equal(T.analyzeText(three, { lang: 'en' }).verdict, 'no-signal', 'three kinds and nothing else stay below the flag');
  const dashed = three + ' Sleep — real sleep — is the work. Boundaries — kind ones — are the job. Joy — small joy — is the point.';
  assert.ok(flagged(T.analyzeText(dashed, { lang: 'en' }).verdict), 'three kinds with dense dashes beside them flag');
  // A columnist's one habit, used four times, is one kind of move: noted, never anchoring.
  const columnist = 'It\'s not the heat, it\'s the humidity, my grandmother used to say about every summer we spent at the lake. '
    + 'It wasn\'t the cottage we loved. It was the hours of nothing in it, the long afternoons with a book and the radio on low. '
    + 'The town isn\'t much to look at now. It\'s two shops and a petrol station where there used to be a dance hall and a cinema. '
    + 'And the lake isn\'t the same lake. It\'s colder, they say, and the fish have gone further out where the boats can\'t follow them.';
  const c = T.analyzeText(columnist, { lang: 'en', sensitivity: 'high' });
  assert.equal(c.signals.find((s) => s.id === 'rhetoric').forms, 1);
  assert.equal(c.verdict, 'no-signal');
});

test('each kind of stock move is recognised, and its variants count as one kind', () => {
  const S = require('../lib/signals.js');
  const kinds = (text) => [...new Set(S.RHETORIC_PATTERNS.filter((p) => S.normalizeQuotes(text).match(p.re)).map((p) => p.form))].sort();
  const cases = {
    reframe: ["It's not a time problem, it's an energy problem.", "Trust isn't a perk you hand out. It's the infrastructure.", 'Not just a tool, but a partner.',
      "It's about progress, not perfection.", "Remote work doesn't fail because of distance. It fails because of a lack of trust."],
    'not-because': ['We stayed not because we had to, but because we wanted to.'],
    'fragment-question': ['We shipped it. The result? Faster deploys.', 'Honestly? It was worth it.', 'Why? Because nobody asked.'],
    'negation-run': ['No fluff. No jargon. Just results.', 'Not a course. Not a coach.'],
    'heres-the': ["Here's the thing: nobody feels ready.", "Here's what nobody tells you about hiring."],
    hook: ['Let that sink in.', "Let's talk about burnout in tech."],
    'comes-in': ["That's where good tooling comes in."],
    'less-more': ['Less noise, more signal.'],
    'and-thats': ["Some days you rest. And that's okay."],
    staccato: ['Clear. Simple. Effective.', 'Send the email. Write the first page. Make the call.'],
    anaphora: ['Burnout looks like cynicism. Like dreading standup. Like staring at a ticket for an hour.'],
  };
  for (const [kind, texts] of Object.entries(cases)) for (const t of texts) assert.deepEqual(kinds(t), [kind], t);
  // Five reframes are one kind.
  assert.deepEqual(kinds(cases.reframe.join(' ')), ['reframe']);
});

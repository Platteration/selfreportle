const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function publisher() {
  const element = (tag) => ({ tag, children: [], appendChild(child) { this.children.push(child); }, addEventListener() {} });
  const sandbox = {
    SRL: { verdicts: {}, attribution: {} }, URLSearchParams, location: { search: '' },
    document: { getElementById() { return { addEventListener() {} }; }, createElement: element },
  };
  // Opened in a tab of its own, as the popup opens it: the page does nothing
  // inside a frame.
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../publisher/publisher.js'), 'utf8').replace('await load(false);', 'globalThis.snippetsForTest = snippets; globalThis.snippetBlockForTest = snippetBlock;');
  vm.runInContext(source, sandbox);
  return sandbox;
}

for (const title of ['</ScRiPt><img src=x onerror="attack()"> & \u2028', "$' $` $& </script><img src=x>"]) {
test('paste-ready JSON-LD safely preserves the title ' + JSON.stringify(title), () => {
  const sandbox = publisher();
  const snippets = sandbox.snippetsForTest({ title, text: {}, site: {}, images: {} }, []);
  const jsonld = snippets.find((sn) => sn.wrap && sn.wrap.includes('application/ld+json'));
  const block = sandbox.snippetBlockForTest(jsonld);
  const html = block.children.find((el) => el.tag === 'pre').textContent;
  assert.equal((html.match(/<script\b/gi) || []).length, 1);
  assert.equal((html.match(/<\/script\s*>/gi) || []).length, 1);
  assert.equal((html.match(/<img\b/gi) || []).length, 0);
  assert.equal(JSON.parse(jsonld.code).headline, title, 'Unicode escapes preserve the title as data');
  const body = html.slice(html.indexOf('\n') + 1, html.lastIndexOf('\n'));
  assert.equal(JSON.parse(body).headline, title, 'Replacement metacharacters remain data in the actual copied HTML');
});
}

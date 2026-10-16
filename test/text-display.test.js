const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Ensure clean global state
delete globalThis.SRL;
const textDisplay = require('../lib/text-display.js');

test('module export and global namespace attachment', () => {
  assert.equal(typeof textDisplay.apply, 'function');
  assert.equal(typeof textDisplay.clear, 'function');
  assert.equal(globalThis.SRL?.textDisplay, textDisplay);
});

function createMockElement(tag = 'p', options = {}) {
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: tag.toUpperCase(),
    isContentEditable: Boolean(options.isContentEditable),
    attributes: attrs,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    closest(selector) {
      if (options.closestMatch) return { tagName: 'DIV' };
      return null;
    },
    querySelector(selector) {
      if (options.hasNestedBlock) return { tagName: 'P' };
      return null;
    },
    children,
  };
  return el;
}

test('font emphasis sets correct level for known AI verdicts', () => {
  const expectedLevels = [
    ['possible-ai', 'low'],
    ['likely-ai', 'medium'],
    ['ai', 'high'],
    ['ai-assisted-disclosed', 'medium'],
    ['ai-disclosed', 'high'],
  ];

  for (const [verdict, expectedLevel] of expectedLevels) {
    const el = createMockElement('p');
    textDisplay.apply(el, verdict, 'font');
    assert.equal(el.getAttribute('data-srl-font'), expectedLevel, `verdict ${verdict} maps to ${expectedLevel}`);

    textDisplay.clear(el);
    assert.equal(el.hasAttribute('data-srl-font'), false, 'clear removes data-srl-font');
  }
});

test('unknown, human, or non-AI verdicts are not emphasized', () => {
  for (const verdict of ['no-signal', 'human-disclosed', 'unknown', '']) {
    const el = createMockElement('p');
    textDisplay.apply(el, verdict, 'font');
    assert.equal(el.hasAttribute('data-srl-font'), false, `verdict ${verdict} must not set font`);
  }
});

test('contentEditable elements and SKIP selectors are protected', () => {
  const editableEl = createMockElement('p', { isContentEditable: true });
  textDisplay.apply(editableEl, 'ai', 'font');
  assert.equal(editableEl.hasAttribute('data-srl-font'), false, 'contentEditable is skipped');

  const skipEl = createMockElement('code', { closestMatch: true });
  textDisplay.apply(skipEl, 'ai', 'font');
  assert.equal(skipEl.hasAttribute('data-srl-font'), false, 'elements matching SKIP are skipped');
});

test('elements with nested blocks do not have font forced onto them', () => {
  const parentEl = createMockElement('div', { hasNestedBlock: true });
  textDisplay.apply(parentEl, 'ai', 'font');
  assert.equal(parentEl.hasAttribute('data-srl-font'), false, 'parent containing nested blocks is not forced');
});

test('style highlight only does not set data-srl-font attribute', () => {
  const el = createMockElement('p');
  textDisplay.apply(el, 'ai', 'highlight');
  assert.equal(el.hasAttribute('data-srl-font'), false, 'highlight-only style does not set font attribute');
});

test('CSS Custom Highlight API integration when supported', () => {
  const highlightsMap = new Map();
  class MockHighlight extends Set {}

  globalThis.Highlight = MockHighlight;
  globalThis.CSS = { highlights: highlightsMap };
  globalThis.NodeFilter = {
    SHOW_ELEMENT: 1,
    SHOW_TEXT: 4,
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
  };

  const textNode = { nodeType: 3, nodeValue: 'Sample text' };
  const mockDoc = {
    createTreeWalker(rootEl, filter, config) {
      let yielded = false;
      return {
        nextNode() {
          if (!yielded && config.acceptNode(textNode) === 1) {
            yielded = true;
            return textNode;
          }
          return null;
        },
      };
    },
    createRange() {
      const range = {
        node: null,
        selectNodeContents(n) { this.node = n; },
      };
      return range;
    },
  };

  const el = createMockElement('p');
  el.ownerDocument = mockDoc;
  el.matches = () => false;

  textDisplay.apply(el, 'ai', 'both');
  assert.equal(el.getAttribute('data-srl-font'), 'high');
  assert.ok(highlightsMap.has('srl-text-ai'), 'highlight group srl-text-ai was registered');
  const group = highlightsMap.get('srl-text-ai');
  assert.equal(group.size, 1, 'one text range was added');

  // Clearing cleans up the highlight group
  textDisplay.clear(el);
  assert.equal(el.hasAttribute('data-srl-font'), false);
  assert.equal(highlightsMap.has('srl-text-ai'), false, 'empty highlight group was deleted from CSS.highlights');

  // Cleanup global mocks
  delete globalThis.Highlight;
  delete globalThis.CSS;
  delete globalThis.NodeFilter;
});

test('clearing an unmarked element is a safe no-op', () => {
  const el = createMockElement('p');
  assert.doesNotThrow(() => textDisplay.clear(el));
});

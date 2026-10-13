/* Optional emphasis for analysed text. No text is rewritten or wrapped. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.textDisplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const LEVELS = new Map([
    ['possible-ai', 'low'], ['likely-ai', 'medium'], ['ai', 'high'],
    ['ai-assisted-disclosed', 'medium'], ['ai-disclosed', 'high'],
  ]);
  // Match the analyser's block boundaries, so a parent never emphasises an
  // unanalysed nested paragraph. Code, controls and editable text stay intact.
  const BLOCKS = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, summary';
  const SKIP = 'srl-overlay, [data-srl-ui], script, style, noscript, template, code, pre, kbd, samp, button, input, textarea, select, option, svg, math, [contenteditable]:not([contenteditable="false"])';
  const marked = new WeakMap();
  const groups = new Map();

  function clear(element) {
    const previous = marked.get(element);
    if (!previous) return;
    if (previous.font) element.removeAttribute('data-srl-font');
    if (previous.highlight) {
      const { name, highlight, ranges } = previous;
      for (const range of ranges) highlight.delete(range);
      if (!highlight.size) {
        if (root.CSS.highlights.get(name) === highlight) root.CSS.highlights.delete(name);
        groups.delete(name);
      }
    }
    marked.delete(element);
  }

  function apply(element, verdict, style) {
    clear(element);
    const level = LEVELS.get(verdict);
    if (!level || element.isContentEditable || element.closest(SKIP)) return;
    const state = {};
    if ((style === 'font' || style === 'both') && !element.querySelector(BLOCKS + ', ' + SKIP)) {
      // Inheritance is safe only for a simple reading block. Never force the
      // font onto a nested block, an editor, or an inline code/control subtree.
      element.setAttribute('data-srl-font', level);
      state.font = true;
    }
    if ((style === 'highlight' || style === 'both') && root.CSS && root.CSS.highlights && root.Highlight) {
      const name = 'srl-text-' + verdict;
      let highlight = groups.get(name);
      if (!highlight) {
        highlight = new root.Highlight();
        groups.set(name, highlight);
        root.CSS.highlights.set(name, highlight);
      }
      const ranges = [];
      const doc = element.ownerDocument;
      const walker = doc.createTreeWalker(element, root.NodeFilter.SHOW_ELEMENT | root.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === 1) return node.matches(BLOCKS + ', ' + SKIP) ? root.NodeFilter.FILTER_REJECT : root.NodeFilter.FILTER_SKIP;
          return node.nodeValue.trim() ? root.NodeFilter.FILTER_ACCEPT : root.NodeFilter.FILTER_SKIP;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const range = doc.createRange();
        range.selectNodeContents(node);
        ranges.push(range);
        highlight.add(range);
      }
      Object.assign(state, { name, highlight, ranges });
    }
    marked.set(element, state);
  }

  return { apply, clear };
});

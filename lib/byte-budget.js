/*
 * lib/byte-budget.js — read a stream up to a byte budget and no further.
 *
 * Used by the worker's fetches and the content script's read of a page's own
 * bytes, where the other end chooses how much to send.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.byteBudget = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class BudgetExceeded extends Error {
    constructor() { super('Metadata byte budget exceeded'); this.name = 'BudgetExceeded'; }
  }

  // Read before allocating a complete body, canceling as soon as it exceeds
  // the budget. A copied prefix never retains a large backing chunk.
  // `onChunk`, when given, is told the length of every chunk as it arrives,
  // so an allowance (the worker's per-tab byte budget) is charged while the
  // body is read rather than once it is done.
  async function read(stream, limit, rejectOverflow = false, onChunk = null) {
    if (!stream || typeof stream.getReader !== 'function') throw new Error('A bounded stream reader is unavailable');
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid byte budget');
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (onChunk) onChunk(value.length);
        if (value.length > limit - total) {
          truncated = true;
          await reader.cancel().catch(() => {});
          if (rejectOverflow) throw new BudgetExceeded();
          chunks.push(value.slice(0, limit - total));
          total = limit;
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { bytes, truncated };
  }

  return { read, BudgetExceeded };
});

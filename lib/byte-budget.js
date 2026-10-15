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
  async function read(stream, limit, rejectOverflow = false) {
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

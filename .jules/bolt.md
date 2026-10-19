## 2023-10-19 - Replace `Array.prototype.reduce` with `for` loops
**Learning:** In V8/Node environments, using `Array.prototype.reduce` inside tight iterative execution paths invokes significant callback overhead when processing numerous items (e.g. lengths computation, concatenations, statistical metric reductions). Standard iteration can be orders of magnitude faster.
**Action:** Always favor using a standard `for` loop over `Array.prototype.reduce` in performance-critical sections to eliminate callback overhead and optimize CPU time usage.

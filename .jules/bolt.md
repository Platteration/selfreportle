
## 2024-05-14 - Optimizing array and byte matching loops
**Learning:** Manual byte matching with `for` loops in `Uint8Array` can be significantly slower than leveraging the native `indexOf` method to find the first matching byte, even if a manual check is needed for subsequent bytes. Functional array methods like `reduce` also have measurable overhead due to callback invocation when used repeatedly in hot paths for simple mathematical reductions.
**Action:** Always favor native `Uint8Array.prototype.indexOf` for byte scanning. Use imperative `for` loops instead of `reduce` for simple summation or mathematical operations in frequently called text parsing functions.

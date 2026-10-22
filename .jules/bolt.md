## 2024-05-24 - Array.from overhead on large strings
**Learning:** `Array.from(string)` to iterate over unicode characters is very slow for large strings and causes a lot of memory allocations.
**Action:** When scanning strings for specific characters, checking with a regular expression fast path (e.g. `!HIDDEN_CHARS_RE.test(text)`) before allocating arrays can lead to 40x speedups on clean data.

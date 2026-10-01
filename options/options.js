(async function () {
  'use strict';
  const S = globalThis.SRL.settings;
  const form = document.getElementById('form');
  const status = document.getElementById('status');

  function fill(s) {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.name === 'maxImageKB') el.value = Math.round(s.maxImageBytes / 1024);
      else if (el.name === 'maxMediaKB') el.value = Math.round(s.maxMediaBytes / 1024);
      else if (el.name === 'disabledHosts') el.value = s.disabledHosts.join('\n');
      else if (el.type === 'checkbox') el.checked = !!s[el.name];
      else if (el.name in s) el.value = s[el.name];
    }
  }

  function read() {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.name === 'maxImageKB') out.maxImageBytes = parseInt(el.value, 10) * 1024;
      else if (el.name === 'maxMediaKB') out.maxMediaBytes = parseInt(el.value, 10) * 1024;
      else if (el.name === 'disabledHosts') out.disabledHosts = el.value.split(/\n+/).map((h) => h.trim()).filter(Boolean);
      else if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number') out[el.name] = parseInt(el.value, 10);
      else out[el.name] = el.value;
    }
    return out;
  }

  function flash(msg) { status.textContent = msg; setTimeout(() => { status.textContent = ''; }, 2000); }

  document.getElementById('version').textContent = chrome.runtime.getManifest().version;
  fill(await S.load());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    /* The browser refuses a host list past its per-item quota. save() has
     * stored the rest by then and says which list it was, so the message
     * does too, rather than flashing Saved or blaming every setting. */
    try { fill(await S.save(read())); flash('Saved'); } catch (err) {
      if (err && err.code === 'hosts') { fill(await S.load()); flash('Saved, except ' + err.message); } else flash('Could not save: ' + ((err && err.message) || err));
    }
  });
  /* Confirmed, because neither can be undone from inside the extension:
   * Reset is every preference and every paused host, Clear domain memory
   * is the counters. The image cache is re-fetchable, so Clear image cache
   * asks nothing. Cancel is the safe answer in both. */
  document.getElementById('reset').addEventListener('click', async () => {
    if (!window.confirm('Reset every setting to its default and clear the paused hosts? Domain memory is not touched.')) return;
    await S.reset();
    fill(await S.load());
    flash('Defaults restored');
  });
  document.getElementById('clearHistory').addEventListener('click', async () => {
    if (!window.confirm('Clear the per-domain memory? The counters cannot be recovered.')) return;
    await chrome.runtime.sendMessage({ type: 'srl:clear-history' });
    flash('Domain memory cleared');
  });
  document.getElementById('clearCache').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'srl:clear-cache' }); flash('Cache cleared'); });
})();

(async function () {
  'use strict';
  const S = globalThis.SRL.settings;
  const form = document.getElementById('form');
  const status = document.getElementById('status');

  function fill(s) {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.name === 'maxImageKB') el.value = Math.round(s.maxImageBytes / 1024);
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
      else if (el.name === 'disabledHosts') out.disabledHosts = el.value.split(/\n+/).map((h) => h.trim()).filter(Boolean);
      else if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'number') out[el.name] = parseInt(el.value, 10);
      else out[el.name] = el.value;
    }
    return out;
  }

  function flash(msg) { status.textContent = msg; setTimeout(() => { status.textContent = ''; }, 2000); }

  fill(await S.load());
  form.addEventListener('submit', async (e) => { e.preventDefault(); fill(await S.save(read())); flash('Saved'); });
  document.getElementById('reset').addEventListener('click', async () => { await chrome.storage.sync.clear(); fill(await S.load()); flash('Defaults restored'); });
  document.getElementById('clearHistory').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'srl:clear-history' }); flash('Domain memory cleared'); });
  document.getElementById('clearCache').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'srl:clear-cache' }); flash('Cache cleared'); });
})();

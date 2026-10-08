/* Selfreportle, the website: the safety net. Loaded first, from <head>, and depending on
   nothing, so that when a file the page needs does not load, or a script throws before the
   checker has started, the visitor reads a short note where the file picker was rather than a
   picker that silently does nothing. The page starts with class="no-js" on <html>, which shows
   the same note (worded for JavaScript being off) in place of the picker; scripts are running,
   so that comes off at once. app.js adds "started" to <html> as the last step of its setup:
   after that the checker reports its own failures in the page and this file stays out of the
   way. Plain old-browser JavaScript on purpose: it has to run where app.js cannot. */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.remove('no-js');

  var MESSAGES = {
    load: 'Part of Selfreportle did not load, so it cannot start. Check your connection and reload the page.',
    start: 'Selfreportle could not start in this browser. Reload the page; if it happens again, try a current Chrome, Edge, Firefox or Safari.'
  };

  /* Only this site's own files count: an extension that injects a script of its own, and
     fails, is not a reason to take the checker away. */
  function ours(url) {
    try { return new URL(url, location.href).origin === location.origin; } catch (e) { return false; }
  }

  var shown = null;
  function show() {
    var note = document.getElementById('startNote');
    if (note && shown) note.textContent = MESSAGES[shown];
  }

  function fail(kind) {
    if (root.classList.contains('started')) return;
    if (shown !== 'load') shown = kind; // a missing file is the cause; the throws that follow are its symptoms
    root.classList.add('start-failed');
    show();
  }

  // Capture phase: a script or stylesheet that fails to load fires on its own element and does
  // not bubble. An exception thrown by a script reaches here as an ErrorEvent on window.
  window.addEventListener('error', function (e) {
    var el = e.target;
    if (el && el !== window && el.tagName) {
      var tag = el.tagName.toLowerCase();
      if ((tag === 'script' && ours(el.src)) || (tag === 'link' && el.rel === 'stylesheet' && ours(el.href))) fail('load');
      return;
    }
    if (e.filename && ours(e.filename)) fail('start');
  }, true);

  // A failure before the body was parsed has no note to write into yet.
  document.addEventListener('DOMContentLoaded', show);
})();

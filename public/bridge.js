/* slidecast bridge — injected as the first script of every deck's index.html.
 * Runs inside the sandboxed iframe. Finds the deck's navigation API, reports
 * steps and changes to the shell, obeys "go", and captures navigation input so
 * the deck never moves on its own. Protocol: every message carries sd: 1.
 */
(function () {
  'use strict';
  if (window.parent === window) return; // deck opened directly: do nothing

  var shell = window.parent;
  window.__SLIDECAST__ = { embedded: true };

  var mode = 'live';
  var adapter = null;
  var lastIndex = -1;
  var pendingGo = null;

  function post(msg) {
    msg.sd = 1;
    shell.postMessage(msg, '*');
  }

  function report(force) {
    if (!adapter) return;
    var i = adapter.current();
    if (typeof i !== 'number' || i !== i) return;
    if (force || i !== lastIndex) {
      lastIndex = i;
      post({ t: 'changed', index: i });
    }
    if (mode === 'preview') silenceMedia();
  }

  // Legacy decks only signal changes through history.replaceState('#n'), so
  // wrap it before any deck script runs. The index is read after the call
  // returns, in case the engine updates its counter afterwards.
  var origReplace = history.replaceState;
  history.replaceState = function () {
    var r = origReplace.apply(history, arguments);
    Promise.resolve().then(function () { report(false); });
    return r;
  };

  function nativeAdapter() {
    var d = window.SLIDECAST_DECK;
    if (!d || d.version !== 1 || !Array.isArray(d.steps)
      || typeof d.go !== 'function' || typeof d.current !== 'function') return null;
    window.addEventListener('slidecast:change', function () { report(false); });
    return {
      name: 'native',
      steps: d.steps.map(function (s) { return { slide: String(s.slide), step: Number(s.step) || 0 }; }),
      go: function (i) { d.go(i); },
      current: function () { return d.current(); },
    };
  }

  function legacyAdapter() {
    var p = window.PRES;
    if (!p || typeof p.go !== 'function' || !Array.isArray(p.pasos)
      || typeof p.actual !== 'function') return null;
    return {
      name: 'legacy',
      steps: p.pasos.map(function (s) {
        s = String(s);
        var at = s.lastIndexOf(':');
        return at < 0 ? { slide: s, step: 0 } : { slide: s.slice(0, at), step: Number(s.slice(at + 1)) || 0 };
      }),
      go: function (i) { p.go(i); },
      current: function () { return p.actual(); },
    };
  }

  function clamp(i) {
    var n = adapter.steps.length;
    i = Math.floor(Number(i));
    if (i !== i) i = 0;
    return Math.max(0, Math.min(n - 1, i));
  }

  function detect() {
    adapter = nativeAdapter() || legacyAdapter();
    if (!adapter) return false;
    if (pendingGo !== null) {
      adapter.go(clamp(pendingGo));
      pendingGo = null;
    }
    lastIndex = adapter.current();
    post({ t: 'ready', adapter: adapter.name, steps: adapter.steps, index: lastIndex });
    return true;
  }

  window.addEventListener('load', function () {
    if (detect()) return;
    var tries = 0;
    var timer = setInterval(function () {
      if (detect()) clearInterval(timer);
      else if (++tries >= 30) {
        clearInterval(timer);
        post({ t: 'error', code: 'no-deck-api' });
      }
    }, 100);
  });

  window.addEventListener('message', function (e) {
    if (e.source !== shell) return;
    var m = e.data;
    if (!m || m.sd !== 1) return;
    if (m.t === 'go') {
      if (!adapter) { pendingGo = m.index; return; }
      adapter.go(clamp(m.index));
      report(true);
    } else if (m.t === 'mode') {
      mode = m.mode === 'preview' ? 'preview' : 'live';
      if (mode === 'preview') silenceMedia();
    }
  });

  function silenceMedia() {
    var media = document.querySelectorAll('audio, video');
    for (var i = 0; i < media.length; i++) {
      media[i].muted = true;
      try { media[i].pause(); } catch (err) { /* ignore */ }
    }
  }

  document.addEventListener('play', function (e) {
    if (mode === 'preview' && e.target && e.target.pause) {
      e.target.muted = true;
      e.target.pause();
    }
  }, true);

  // ---- input capture -------------------------------------------------------

  function swallow(e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  function keyAction(e) {
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': return 'next';
      case ' ': case 'Spacebar': return e.shiftKey ? 'prev' : 'next';
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': return 'prev';
      case 'Home': return 'first';
      case 'End': return 'last';
      case 'b': case 'B': case '.': return 'blank';
      case 'f': case 'F': return 'fullscreen';
      case 'l': case 'L': return 'live';
      default: return null;
    }
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onKey(e) {
    if (mode === 'preview') { swallow(e); return; }
    if (isEditable(e.target)) return;
    var action = keyAction(e);
    if (!action) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Keep browser shortcuts working, but the deck must not move.
      e.stopImmediatePropagation();
      return;
    }
    swallow(e);
    if (e.type === 'keydown' && !e.repeat) post({ t: 'input', action: action });
  }

  var INTERACTIVE = 'a, button, input, select, textarea, label, summary, [data-interactive], [contenteditable]';

  function elementOf(target) {
    var el = target && target.nodeType === 1 ? target : target && target.parentElement;
    return el && el.closest ? el : null;
  }

  function onClick(e) {
    if (mode === 'preview') { swallow(e); return; }
    if (e.button !== 0) return;
    var el = elementOf(e.target);
    if (!el) return;
    var nav = el.closest('#prev, #next');
    if (nav) {
      swallow(e);
      post({ t: 'input', action: nav.id === 'prev' ? 'prev' : 'next' });
      return;
    }
    if (el.closest(INTERACTIVE)) return;
    swallow(e);
    post({ t: 'input', action: 'next' });
  }

  var touchStart = null;

  // A swipe that starts on an interactive element (dragging a slider, panning a
  // canvas) belongs to the deck, as a click on one does.
  function onTouchStart(e) {
    if (mode === 'preview') { swallow(e); return; }
    var t = e.touches && e.touches[0];
    var el = elementOf(e.target);
    touchStart = t && !(el && el.closest(INTERACTIVE)) ? { x: t.clientX, y: t.clientY } : null;
  }

  function onTouchEnd(e) {
    if (mode === 'preview') { swallow(e); return; }
    var t = e.changedTouches && e.changedTouches[0];
    if (!touchStart || !t) return;
    var dx = t.clientX - touchStart.x;
    var dy = t.clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      swallow(e);
      post({ t: 'input', action: dx < 0 ? 'next' : 'prev' });
    }
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('keypress', onKey, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
  window.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
}());

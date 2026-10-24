# Deck format

A slidecast deck is a folder:

```
my-talk/
├── index.html    required: the whole presentation
├── deck.json     optional: title, settings and speaker notes
├── cover.png     optional: thumbnail shown in the deck list and selector
└── …             optional: images, fonts, scripts it references
```

The folder name is the deck's name in URLs (`/my-talk`): lowercase letters,
digits and hyphens, starting with a letter or digit, at most 63 characters.
`admin`, `api`, `ws`, `_slidecast`, `_deck` and `health` are reserved.

A single self-contained `index.html` (images inlined as `data:` URLs) is the
simplest deck: upload it as a `.html` file from the admin panel.

## deck.json

```json
{
  "slidecast": 1,
  "title": "Electric rockets",
  "aspect": "16:9",
  "viewerNav": "back",
  "slides": {
    "intro": {
      "notes": "Markdown shown to the presenter on every step of this slide.",
      "steps": { "2": "Markdown shown only on step 2 of this slide." }
    }
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `slidecast` | Format version, always `1`. | `1` |
| `title` | Shown in lists and the browser tab. | the `<title>` of `index.html`, else the folder name |
| `aspect` | Shape of the slide in the presenter and editor views, `"W:H"`. | `"16:9"` |
| `viewerNav` | What viewers may do: `follow` (locked to the presenter), `back` (may look back, never past the live step), `free` (anywhere). The presenter can change it live. | `"back"` |
| `cover` | Path of the deck's thumbnail image inside the folder (png, jpg, webp, avif, gif or svg). | `cover.webp`, `cover.png`, `cover.jpg`, `cover.jpeg`, `cover.avif` or `cover.svg` if present; otherwise a live miniature of the first slide |
| `slides` | Notes per slide id: `notes` for the whole slide, `steps` for individual steps (keys are step numbers). | `{}` |

Notes are Markdown. Raw HTML in notes is shown as text, not rendered. Any other
field, at the top level or inside a slide, is kept untouched when slidecast
saves the file, so you can store your own data there. The admin panel's notes
editor writes this file for you.

## How slidecast drives a deck

slidecast shows `index.html` inside a sandboxed iframe and injects a small
script (the *bridge*) before any of the deck's own scripts. The bridge needs
the deck to expose its steps and a way to jump to one of them. A deck is a flat
list of **steps**; each step belongs to a slide (`slide` is the slide's id,
`step` its number inside that slide, from 0).

Navigation always comes from slidecast: arrows, space, PageUp/PageDown (most
presentation clickers), on-screen buttons and swipes are captured by the
bridge and sent to the presenter's live state, which then tells the deck where
to go. A deck therefore must not move by itself.

### Native API (for new decks)

```js
window.SLIDECAST_DECK = {
  version: 1,
  steps: [{ slide: 'intro', step: 0 }, { slide: 'how', step: 0 }, { slide: 'how', step: 1 }],
  go(index) { /* show steps[index]; no animation needed */ },
  current() { return 0; /* index shown now */ },
};
// After every change, including those caused by go():
window.dispatchEvent(new CustomEvent('slidecast:change', { detail: { index } }));
```

Define it before the page's `load` event. The bridge also sets
`window.__SLIDECAST__ = { embedded: true }` before your scripts run: when it is
present, do **not** bind your own keyboard, click or swipe navigation (your
deck can keep it for when the file is opened directly).

A complete, working example is the engine of [`examples/demo`](../examples/demo/index.html):

<!-- demo-api:start -->
```js
// --- slidecast native deck API: minimal engine -------------------------------
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var steps = [];
  slides.forEach(function (s) {
    var n = Number(s.dataset.steps || 1);
    for (var k = 0; k < n; k++) steps.push({ slide: s.id, step: k });
  });
  var current = 0;

  function render() {
    var at = steps[current];
    slides.forEach(function (s) {
      s.classList.toggle('active', s.id === at.slide);
      s.querySelectorAll('[data-step]').forEach(function (el) {
        el.classList.toggle('shown', s.id === at.slide && Number(el.dataset.step) <= at.step);
      });
    });
  }

  function go(index) {
    current = Math.max(0, Math.min(steps.length - 1, Math.floor(index) || 0));
    render();
    window.dispatchEvent(new CustomEvent('slidecast:change', { detail: { index: current } }));
  }

  window.SLIDECAST_DECK = {
    version: 1,
    steps: steps,
    go: go,
    current: function () { return current; },
  };

  // Own navigation only when opened directly; inside slidecast the shell drives.
  if (!window.__SLIDECAST__) {
    window.addEventListener('keydown', function (e) {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].indexOf(e.key) >= 0) go(current + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].indexOf(e.key) >= 0) go(current - 1);
    });
  }

  go(0);
})();
// --- end of the deck API ----------------------------------------------------
```
<!-- demo-api:end -->

### Legacy `PRES` decks

Decks built on the older `PRES` engine work unchanged. The bridge uses
`window.PRES.pasos` (`["slideId:step", …]`) as the step list, `PRES.go(i)` to
jump and `PRES.actual()` to read the current step, and detects changes through
`history.replaceState`.

### Rules inside the iframe

The sandbox (`allow-scripts`, no `allow-same-origin`) keeps a deck away from
slidecast's sessions, so a downloaded or AI-written deck cannot act as the
admin. Consequences:

- no `localStorage`, `sessionStorage`, IndexedDB or cookies;
- no `fetch`/XHR to the slidecast server (relative `<img>`, `<link>`,
  `<script>` and `<video>` URLs do work: they are served with the deck);
- links that open new tabs work; the deck cannot navigate the presenter's page;
- full screen is handled by slidecast (`F`), not by the deck.

Clicks anywhere on a slide mean "next", and horizontal swipes move forward or
back. Clicks and swipes that start on links, buttons, form fields, `<summary>`,
or any element inside one marked `data-interactive`, reach the deck normally
(so a slider can be dragged without changing slides):

```html
<div class="simulation" data-interactive> … sliders and canvases … </div>
```

## Instructions for your AI assistant

Paste this when asking an AI to write a deck:

```text
Write a presentation as ONE self-contained index.html file for slidecast.
- A fixed 1600×900 stage scaled to the window (transform: scale), one
  <section class="slide" id="…"> per slide with a short, unique, stable id.
- Reveal content in steps inside a slide with data-step="1", data-step="2"…;
  a slide's step count is its highest data-step + 1 (set data-steps="N" on the
  section).
- Expose the slidecast native API, defined before the load event:
    window.SLIDECAST_DECK = { version: 1, steps: [{slide, step}, …],
      go(index) {…}, current() {…} };
  and after every change dispatch
    window.dispatchEvent(new CustomEvent('slidecast:change', {detail: {index}})).
- If window.__SLIDECAST__ exists, do not bind any keyboard, click or swipe
  navigation; otherwise ArrowRight/Space/PageDown go forward and
  ArrowLeft/PageUp go back.
- No external network requests, no localStorage, no cookies, no fetch.
  Inline images as data: URLs or reference files next to index.html.
- Interactive widgets (buttons, sliders, canvases) go inside an element with
  the data-interactive attribute.
- Also write deck.json with {"slidecast": 1, "title": "…", "slides": {"<slide id>":
  {"notes": "speaker notes in Markdown", "steps": {"1": "note for step 1"}}}}.
```

Start from `slidecast new my-talk`, which copies the demo deck, if you prefer
editing a working example.

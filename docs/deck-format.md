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
    },
    "quiz": {
      "poll": {
        "question": "Which planet is the largest?",
        "options": ["Mars", "Jupiter", "Venus"],
        "multiple": false,
        "correct": [1]
      }
    }
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `slidecast` | Format version, always `1`. | `1` |
| `title` | Shown in lists and the browser tab. | the `<title>` of `index.html`, else the folder name |
| `aspect` | Shape of the slide in the presenter and editor views and, when `frozen`, on every screen, `"W:H"`. | `"16:9"` |
| `viewerNav` | What viewers may do: `follow` (locked to the presenter), `back` (may look back, never past the live step), `free` (anywhere). The presenter can change it live. | `"back"` |
| `cover` | Path of the deck's thumbnail image inside the folder (png, jpg, webp, avif, gif or svg). | `cover.webp`, `cover.png`, `cover.jpg`, `cover.jpeg`, `cover.avif` or `cover.svg` if present; otherwise a live miniature of the first slide |
| `contest` | Contest mode: polls with right answers score points and make a ranking. See [Contest mode](#contest-mode). | off |
| `frozen` | `true`: every screen lays the deck out at one fixed size, 1920 pixels on the long side with the shape of `aspect`, and scales it to fit. Responsive decks lose their phone layout; the deck's own full screen is disabled (`F` still works); open screens reload when it or the aspect changes through **Settings** or a deck update. See [Frozen decks](#frozen-decks). | off |
| `pointer` | `true`: presenters can show a laser dot on every screen that shows the live step (button or `P` in the presenter view). Needs `frozen`. | off |
| `slides` | Per slide id: `notes` for the whole slide, `steps` for individual steps (keys are step numbers), and an optional `poll`. | `{}` |

A slide's `poll` is launched from the presenter view on any step of that
slide; the audience answers it on their devices. `question` (up to 300
characters) and `options` (2 to 10 answers of up to 150 characters) are plain
text; `multiple: true` lets each person choose several answers (default: one).
`correct` optionally lists the right answers by position, counting from 0
(`[1]` is the second answer): when the presenter closes answers and shows
the results, everyone sees them and whether they got it right. With one answer to choose, any of the listed ones
counts as right; with several, choosing exactly them is right, only some of
them is partly right, and any other answer makes it wrong. Without `correct`
it is an opinion poll. A poll without a question or with fewer than two
answers is kept but cannot be launched. The notes editor writes polls too.

### Contest mode

`contest` turns the deck's polls with right answers into a contest with a
ranking (the admin panel's deck **Settings** writes it):

```json
{
  "contest": { "on": true, "points": 1000, "time": 30, "speed": 50 },
  "slides": {
    "quiz": {
      "poll": {
        "question": "Which keys move the slides?",
        "options": ["Left", "Right", "Q", "Space"],
        "multiple": true,
        "correct": [0, 1, 3],
        "points": 2000,
        "time": 60
      }
    },
    "warmup": { "poll": { "question": "…", "options": ["…", "…"], "correct": [0], "contest": false } }
  }
}
```

| Field | Meaning | Default |
| --- | --- | --- |
| `contest.on` | Contest mode. Every viewer must enter with a name (a nickname is fine), unique in the room. | `false` |
| `contest.points` | Points a question gives, 1–10000. | `1000` |
| `contest.time` | Countdown in seconds, 5–600, or `null` for none. When it ends, answers close by themselves. | `30` |
| `contest.speed` | Slowness penalty, 0–100 %: how much of the points answering at the last moment loses. `0`: time does not matter. | `50` |
| poll `points` | This question's points, instead of the deck's. | the deck's |
| poll `time` | This question's countdown in seconds, or `null` for none. | the deck's |
| poll `contest` | `false`: this question does not count (a warm-up). | counts |

Only polls with right answers count; opinion polls never do. A question
scores once the presenter closes answers and shows the results; reopening
answers puts its points on hold until it is closed again. A field with a
wrong value is ignored (the default applies), so a hand-written deck keeps
its contest.

How a question scores. P is its points, C its right answers, W its wrong
ones:

- **Correctness `c`.** One answer to choose: 1 if it is a right one, else 0.
  Several: right ones chosen over C, minus wrong ones chosen over W, never
  below 0. Ticking everything gives 0, so guessing does not pay.
- **Points.** `P · c · (1 − speed · t / T)`, rounded. `t` is when the server
  received the answer (the last one, if it was changed), counting only the
  time answers were open; `T` is the countdown, or, without one, how long
  answers were open. A wrong answer, however fast, gets 0.

With P = 1000, speed 50 % and a 20 s countdown, on a question with 5 options
of which `[0, 2]` are right: `[0, 2]` at 10 s gives **750**; `[0, 1]` at once
gives 1000 · (1/2 − 1/3) = **167**; `[1, 3]` gives **0**. Closing answers
early, when everyone has answered, does not change anyone's points.
Reopening answers resumes the clock where it stopped; a question whose
countdown is used up cannot be reopened. Changing a question's points, its
right answers or the deck's settings scores the questions already shown
again. The ranking adds up every question that counted; equal points share a
place.

### Frozen decks

A deck normally lays itself out for each window: a phone held upright gets a
narrow window, the projector a wide one. With `frozen: true` (the admin
panel's deck **Settings**, *Same layout on every screen*), slidecast gives
the deck the same window everywhere: 1920×1080 for `16:9`, 1920×1440 for
`4:3`, 1080×1920 for `9:16` (1920 on the long side), and scales the result
to each screen with black bars, like a picture. Inside a frozen deck
`innerWidth` and `innerHeight` are always that size, so the presenter
view, the projector and every phone show exactly the same slide, and the
shared `pointer` lands on the same word everywhere.

A deck with a fixed stage scaled to its window (the
[AI instructions](#instructions-for-your-ai-assistant) below) looks the same
frozen or not. What can still differ from one device to another:

- fonts that are not embedded: a device without the font uses another one,
  and lines break elsewhere;
- `matchMedia` on `pointer`, `hover` or `resolution`, and
  `devicePixelRatio`, which ignores the scaling (a canvas sized
  `innerWidth × devicePixelRatio` gets very large on phones);
- the state of widgets each person plays with on their own device.

Presenter, projector and audience pages reload by themselves when the layout
changes; an open notes editor keeps the old one until it is reloaded.

Notes are Markdown. Raw HTML in notes is shown as text, not rendered. Any other
field, at the top level or inside a slide, is kept untouched when slidecast
saves the file, so you can store your own data there. The admin panel's notes
editor writes this file for you.

Notes and polls belong to a slide's **id**, so give slides stable names (`intro`,
`results`), not positions (`s1`, `s2`, `s3`): when you update a deck from the
admin panel, notes are kept for every slide id the new version still has, and
deleted for the ids it no longer has. Renaming an id loses its notes; ids
numbered by position point to a different slide as soon as one is inserted.
Step notes go by step number, so add new steps at the end of a slide. When
asking an AI to change a deck, ask it to keep the same slide ids.

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
- full screen is handled by slidecast (`F`), not by the deck (in a frozen
  deck, the deck's own `requestFullscreen()` is refused).

Clicks anywhere on a slide mean "next", and horizontal swipes move forward or
back (except on the viewer page, which has on-screen arrows on touch screens
instead: a swipe there does nothing). Clicks and swipes that start on links, buttons, form fields, `<summary>`,
or any element inside one marked `data-interactive`, reach the deck normally
(so a slider can be dragged without changing slides):

```html
<div class="simulation" data-interactive> … sliders and canvases … </div>
```

## Instructions for your AI assistant

Paste this when asking an AI to write a deck:

```text
Write a presentation as ONE self-contained index.html file for slidecast.
- A fixed 1600×900 stage (or another W×H with the same shape as "aspect" in
  deck.json) scaled to the window with s = min(innerWidth/W, innerHeight/H),
  centred both ways and recomputed on resize; one
  <section class="slide" id="…"> per slide with a short, unique, stable id.
- The layout never depends on the window: size everything in stage pixels,
  no vw/vh/dvh units, no width, height or orientation media queries, no
  matchMedia, no screen.*.
- Embed the fonts (@font-face with data: URLs or font files next to
  index.html), never system-only or Google fonts, so text breaks the same on
  every device.
- Canvases have a fixed bitmap size (their width and height attributes, for
  example twice their size on the stage), never innerWidth × devicePixelRatio.
- Never call requestFullscreen, and do not bind mouse-wheel navigation.
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
- Also write deck.json with {"slidecast": 1, "title": "…", "aspect": "16:9",
  "slides": {"<slide id>": {"notes": "speaker notes in Markdown",
  "steps": {"1": "note for step 1"}}}}, with "aspect" matching the stage.
- For a question to the audience, give that slide a poll in deck.json:
  "poll": {"question": "…", "options": ["…", "…"], "multiple": false, "correct": [0]}
  (2 to 10 short plain-text answers; "multiple": true allows several;
  "correct" lists the right answers by position from 0, or leave it out for
  an opinion poll).
```

Start from `slidecast new my-talk`, which copies the demo deck, if you prefer
editing a working example.

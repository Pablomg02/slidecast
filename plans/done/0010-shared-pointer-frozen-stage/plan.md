---
id: "0010"
title: "Shared pointer and frozen virtual resolution"
type: plan
created: 2026-11-18
---

# 0010 — Shared pointer and frozen virtual resolution

## Justification

When the presenter moves the mouse over the slide to point at something,
nobody else sees it: the audience's phones and laptops and the projector only
follow the step. Pointing at a formula or a part of a diagram has to be said
in words.

A pointer cannot simply send "x % of the iframe". Every screen gives the deck
iframe a different size, and a deck lays itself out from its window size in
pixels (not its ratio). The audience iframe even fills the whole screen
(`.viewer-stage { inset: 0 }`) while the deck letterboxes itself inside. The
same fraction lands on different content on different screens. The design
conversation is in [research/conversation.md](research/conversation.md).

The fix is to make every screen lay the deck out identically: a per-deck
**frozen** mode renders the iframe at one fixed *virtual resolution* derived
from the deck's `aspect` and scales it to fit each screen. On top of it, a
per-deck **pointer** setting lets each presenter show a coloured laser dot on
every screen.

### Goals

- G1. A deck setting `frozen` (default off): every view (audience, projector,
  presenter current and next, editor, thumbnails) renders the deck iframe at
  a virtual resolution of 1920 on the long side, the other side from
  `aspect`, scaled with contain-fit and letterboxed. With `frozen` off,
  everything behaves exactly as today.
- G2. A deck setting `pointer` (default off), allowed only with `frozen` on.
- G3. In the presenter view, with `pointer` on, each presenter turns a laser
  on and off with a button or the P key. While it is on, their mouse position
  over the current slide appears as a dot in their own colour on every other
  screen of the deck that shows the live step, at the same place on the
  content, including while the mouse is held still.
- G4. Every open screen always uses the deck's current layout: changing
  `frozen` or the aspect of a frozen deck makes every open screen reload by
  itself on the live step (participants keep their identity, the presenter
  keeps the talk timer), and a screen that reconnects later with a stale
  layout reloads too.
- G5. Bandwidth stays small: at most 15 positions per second per presenter,
  only while the laser is on, a keep-alive every 1.5 s while held still,
  tiny messages, stale positions dropped for slow sockets.
- G6. Pablo's existing decks (fixed 1600×900 stage, centred) look the same as
  today when frozen, and the pointer lands on the same content everywhere.
- G7. The deck format docs and the instructions for AI assistants tell deck
  authors how to write decks that behave perfectly when frozen.

### Non-goals

- A pointer from phones or touch screens (user decision), and from the
  audience page of a controlling viewer.
- Anchoring the pointer to elements or highlighting elements.
- Overriding `devicePixelRatio` inside frozen decks to save canvas memory on
  phones (documented as a deck-author rule instead).
- Changing Pablo's deck templates in the sistemas-de-propulsion repository
  (embed fonts, drop their own fullscreen button): a separate task in that
  repository.
- Fixing keys the bridge does not capture (`I`, `?`, `E` in the propulsion
  template, the mouse wheel) that still reach decks: separate ticket.
- An adapter for the drone-bench export runtime (it is not drivable today).
- Showing the pointer in the editor or in thumbnails.

## Plan

### Context

Line numbers below were taken on 2026-11-18 at commit `86fb727` (plan 0009
committed); locate code by function name if they have moved.

Commands (no build step, plain ES modules, Node ≥ 20, no linter):

- Unit tests: `npm test` (`node --test --test-timeout=30000 test/*.test.js`;
  210 passing at baseline). One file: `node --test test/pointer-live.test.js`.
- Syntax check: `npm run check`.
- E2E (Chromium only, `playwright.config.js`): on this machine always
  `PW_DISABLE_TS_ESM=1 npx playwright test` (one spec:
  `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/pointer.spec.js`).

Research in this folder:

- [research/conversation.md](research/conversation.md) — the design
  conversation and the alternatives set aside.
- [research/scaled-iframe-browsers.md](research/scaled-iframe-browsers.md) —
  browser behaviour of a fixed-size iframe under an ancestor transform.
- [research/existing-decks.md](research/existing-decks.md) — audit of Pablo's
  real decks under frozen mode.
- [plan-review.md](plan-review.md) — the independent critique and what
  changed.

How things work today:

- **Deck frame.** `createDeckFrame(container, deckUrl, { mode, query, swipe })`
  in `public/shell.js` (~l. 341) creates `<iframe.deck-frame sandbox="allow-scripts"
  allow="fullscreen; autoplay">`, talks to the bridge by postMessage and posts
  `{t:'mode', mode: frame.mode, swipe}` in three places (`setMode`, on
  `ready`, on `load`). Callers: `public/viewer.js` (~l. 107, audience and
  projector, `mode:'live'`, `swipe:false`), `public/presenter.js` (~l. 294
  current and ~l. 299 next, both `mode:'preview'`), `public/editor.js`
  (~l. 216, `mode:'live'`), `public/admin.js` (~l. 391, stage probe: only
  reads the steps), `deckThumb({ cover, deckUrl, aspect, locked })` in
  `public/shell.js` (~l. 147–180).
- **Precedent.** `deckThumb` already renders the iframe in a `div.thumb-live`
  of 1280 px × height-by-aspect and scales it with
  `transform: scale(box.clientWidth / W)` from a ResizeObserver
  (`public/shell.js` ~l. 166–171; CSS `.thumb-live` ~l. 208–209).
- **Bridge.** `public/bridge.js` is served from `public/` and injected as the
  first script of every deck's `index.html` (`src/deckfiles.js` ~l. 11, 27–42),
  so it is never stale. Its `message` handler (~l. 105–118) ignores unknown
  fields. The only pixel constant is the swipe threshold `Math.abs(dx) > 60`
  (~l. 219), in iframe CSS pixels.
- **Views.** `.deck-frame.preview { pointer-events: none }`
  (`public/style.css` ~l. 307): in the presenter page the current slide never
  takes the mouse, so the page itself receives `pointermove` over
  `currentBox`. The presenter and editor boxes already have the deck's
  aspect (`presenter.js` ~l. 32, `editor.js` ~l. 81). The viewer stage fills
  `#app`; overlays (`.blank-overlay` z 5, `.idle-cover` z 6, ranking, poll,
  badges) are positioned against `#app`/`.viewer-stage`, not the iframe. In
  `back`/`free` modes a viewer may show a step `local` other than the live
  `live.index` (`viewer.js` ~l. 108–123, 172–181).
- **Settings.** `deck.json` fields are normalised in `normalizeMeta`
  (`src/decks.js` ~l. 82–90, only `aspect` and `viewerNav`); contest settings
  use an accessor instead (`contestOf`, `src/contest.js` ~l. 36–38).
  `ASPECT_RE` (`src/decks.js` ~l. 17) accepts `0:9`. `updateSettings(slug,
  {title, viewerNav, aspect, contest})` (`src/decks.js` ~l. 302–324)
  validates with `DeckError('ERR_BAD_INPUT', …)`. PATCH
  `/api/admin/decks/:slug` (`src/routes/admin.js` ~l. 187–197) calls it, then
  `live.setViewerNav` and `live.setContest`. Pages read the deck once from
  `/api/decks/:slug` (`src/routes/api.js` ~l. 56–68; `viewer.js` ~l. 17,
  `presenter.js` ~l. 16, `editor.js` ~l. 12). The admin settings dialog is
  `openSettings(d)` in `public/admin.js` (~l. 528–627); it has no `aspect`
  field today; `describeContest` (~l. 553–565) shows how dependent fields are
  disabled.
- **Live.** `src/live.js`: per-deck state from `stateOf` (~l. 72–112),
  `snapshot` (~l. 115–128), `broadcast`, `send`, presenter list per device in
  `roomFor` (~l. 145) sent by `sendRoom`/`roomChanged` (~l. 173, 191; the
  latter is debounced), room commands in `ROOM_COMMANDS` dispatched by
  `roomCommand` (~l. 789–794), role and `canPresent` re-checked on every
  message in `onMessage` (~l. 905–927), the close handler (~l. 592–604), the
  heartbeat that terminates silent sockets (~l. 931–942),
  `setViewerNav`/`setContest`/`resetDeck` in the returned API
  (~l. 987–1062). `CLOSE.again = 4000` makes the client reload
  (`public/shell.js` `FINAL`, ~l. 190; handled by `viewer.js` ~l. 237,
  **not** by `presenter.js` ~l. 545–548). A page coming back from the
  background just reconnects (`connectLive`, `public/shell.js` ~l. 207–211,
  288), it never reloads. Limits use `slidingLimit` from `src/rooms.js`
  (~l. 89). No limiter applies to presenter sockets today;
  `socket.bufferedAmount` is not used anywhere yet.
- **Presenter.** Toolbar `.p-nav` = `btnFirst, btnPrev, counter, btnNext,
  btnLast` (`presenter.js` ~l. 144–145); keydown handler ~l. 557–565; the
  talk timer lives only in memory (`timerStart`, `timerElapsed`, ~l. 584).
- **Keys.** `keyActionFromEvent` (`public/shell.js` ~l. 429–446) and the
  bridge's `keyAction` (~l. 140–155) share a table; `l` is taken (`live`),
  `p` is free.
- **Tests.** `test/helpers.js` (~l. 43–102: `buildServer`, `listen`,
  `openRooms`, `wsClient(...).next(pred)`); second presenter device via
  `loginCookie` (`test/rooms.test.js` ~l. 38–42, 330–351). E2E server
  `test/e2e/server.js` (static harness at `/__test/harness.html` through
  `extraRoutes`); per-role browser contexts and deck.json edits through
  `srv.dataDir` + `srv.app.slidecast.live.resetDeck` (`test/e2e/contest.spec.js`
  ~l. 9–34, 74–88).
- **Docs.** `docs/deck-format.md` settings table (~l. 44–54) and
  "Instructions for your AI assistant" (~l. 254–279), which must stay
  identical to `#ai-prompt` in `site/index.html` (`test/docs.test.js`
  ~l. 20–29). `docs/security.md` threat model (~l. 9–14) and limits in prose
  (~l. 111–141). CHANGELOG `[Unreleased]` bullets name the plan, the format
  and protocol additions.

### Approach

**Layout key.** One string describes how a deck is laid out:
`layout = "<w>x<h>"` (e.g. `"1920x1080"`) when the deck is frozen, `null`
otherwise. The server computes it (`layoutOf(meta)` from `frozen` and
`aspect`), pages receive it from `/api/decks/:slug` and parse it; the live
state keeps it and puts it in every `state` snapshot. A page whose loaded
layout differs from the snapshot's reloads itself (with a loop guard). This
single key covers turning `frozen` on or off, changing the aspect of a frozen
deck, deck updates, and screens that were asleep or offline when it changed.

**Frozen frame (shell only).** `createDeckFrame` gains an option `virtual`
(`{w, h}` or `null`). With `null` nothing changes: same DOM, same messages.
With a size, the iframe goes inside `div.deck-virtual` of exactly `w×h` CSS
px, `transform-origin: 0 0`, positioned absolutely at the container's top
left; a ResizeObserver on the container computes `s = min(cw/w, ch/h)` and
centres it with `translate(x, y) scale(s)`. A sibling `div.deck-layer` is
placed exactly over the displayed (scaled) iframe for overlays such as
pointer dots, so dots keep a constant on-screen size. The shell tells the
bridge the scale inside the existing `mode` message (only when virtual), so
the swipe threshold stays 60 *screen* px. In frozen mode the iframe gets
`allow="autoplay"` without `fullscreen`: a deck's own `requestFullscreen()`
would put the bare iframe in the top layer with `transform: none` and
full-screen size, breaking the frozen layout and hiding the pointer;
slidecast's own F key fullscreens the whole page and keeps working.
`deckThumb` is rebuilt on the same option, so there is one scaling
implementation. The virtual size is 1920 on the long side: on a 1080p
projector the scale is exactly 1, laptops scale ≤ 1 (Safari blurs content
scaled above 1), and for Pablo's 1600×900 decks the inner fit becomes an
exact 1.2 with no translation.

**Settings.** `frozen` and `pointer` are optional booleans in `deck.json`
read through accessors (`frozenOf`, `pointerOf`), never added by
`normalizeMeta`, and deleted from the file when turned off, so decks that do
not use them keep byte-identical `deck.json`, downloads and update checks.
`pointer` requires `frozen`; turning `frozen` off also removes `pointer`. The
settings dialog gets a "Screens" section: aspect, frozen and pointer.

**Applying a layout change live.** Moving an iframe into or out of a wrapper
reloads it anyway, so a layout change closes every socket of the deck with
the existing reload code `CLOSE.again` (4000), and the snapshot's `layout`
catches every screen that was not connected at that moment. The presenter
page learns to reload on that code and keeps its talk timer in
`sessionStorage`.

**Pointer protocol.** A room command, never stored on disk, never logged,
never in the snapshot (the snapshot only carries the `pointer` flag):

| Direction | Message | Meaning |
| --- | --- | --- |
| presenter → server | `{t:'ptr', on:true}` | laser on: reserve this device's colour slot |
| presenter → server | `{t:'ptr', x, y}` | position; integers 0..10000, fraction × 10000 of the iframe |
| presenter → server | `{t:'ptr', off:true}` | hide my dot |
| server → others | `{t:'ptr', id, x, y}` | show/move the dot of slot `id` |
| server → others | `{t:'ptr', id, off:true}` | hide the dot of slot `id` |
| server → all | `{t:'ptr', clear:true}` | hide every dot |

A slot is a small integer per presenter *device* (the unit of the presenters
list and kick-presenter), the lowest free one, allocated on the first `on` or
move and freed when that device's last presenter window leaves the room. The
colour is `PTR_COLORS[id % 6]` on the client. Presenters learn their own slot
through the `ptr` field added to their own device row in the `room` message;
the audience only ever sees the integer, no device id, session or name.
While the laser is on and the mouse is over the slide, the page re-sends the
last position every 1.5 s, so a dot held still stays visible and screens
that join later see it within 1.5 s. Moves are capped server-side at 30 per
second per device (dropped silently), skipped for sockets with more than
16 KiB queued, and dots hide on step change and blank, and on viewers that
are not on the live step.

**Alternatives discarded** (details in research/conversation.md): computing
the slide rectangle assuming centred fixed-stage decks; measuring the stage
inside the iframe from the bridge; anchoring to elements; highlighting
elements; a single "take the pointer" token instead of colours (more state
and commands, no gain); applying layout changes only on manual reload
(confusing in class); redirecting the deck's own fullscreen to the shell (a
shim of the whole Fullscreen API, and iPhone has no element fullscreen);
closing sockets with 4000 alone (misses screens asleep at that moment).

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | Frozen mode is a per-deck boolean `frozen`, default off. | Nothing changes for anyone until a deck opts in. | user |
| D2 | `pointer` is a per-deck boolean, default off, only allowed when `frozen` is on. | Only a frozen layout makes iframe fractions land on the same content. | user |
| D3 | No pointer from phones/touch; only from the presenter page with a mouse (`pointerType === 'mouse'`); the laser button is hidden under `@media (hover: none), (pointer: coarse)`. | User choice; the button would do nothing there. | user, review |
| D4 | One colour per presenter device, several dots at once; palette of 6, repeating beyond 6. | No more complex than a token; no shared state or take/give commands. | user |
| D5 | Virtual resolution (`virtualSize(aspect)` in `src/decks.js`): 1920 on the long side, the other side `Math.round(1920 × short / long)`; an aspect with a zero or invalid side falls back to 16:9 (1920×1080). | Scale 1 on 1080p projectors, ≤ 1 on laptops (Safari blurs above 1); no visible difference for audited decks. | research (scaled-iframe-browsers.md, existing-decks.md) |
| D6 | In frozen mode the iframe's `allow` is `autoplay` only (no `fullscreen`); the deck's own fullscreen silently fails, slidecast's F key keeps working. | Deck fullscreen puts the bare iframe in the top layer with `transform:none`, breaking the layout and hiding the pointer. | user |
| D7 | Open screens follow layout changes by themselves: a change closes every socket of the deck with `CLOSE.again`, and every page compares the snapshot's `layout` with the one it loaded and reloads when they differ. `presenter.js` reloads on status `again`. | Re-mounting the iframe reloads it anyway; a screen left on the old layout would make the pointer silently miss. | user, review |
| D8 | The laser is toggled per presenter page with a toolbar button and the P key; off on page load. While on, the cursor over the slide is hidden and replaced by the presenter's own dot drawn locally. | Moving the mouse to press buttons sends nothing; the presenter sees what the audience sees. | user |
| D9 | Update the deck-format docs and the AI instructions with frozen-friendly rules (embedded fonts, no layout that depends on the window, fixed canvases, no own fullscreen, always write `aspect`). | Font fallbacks and per-device reflow are the remaining reasons a dot can miss. | user |
| D10 | `frozen`/`pointer` are not added by `normalizeMeta`; they are read with `frozenOf(meta)` / `pointerOf(meta)` and deleted from deck.json when off. | Keeps deck.json, the defaults download and the update "same deck.json" check byte-identical for decks that do not use them (`test/admin.test.js` ~l. 222). | research |
| D11 | Turning `frozen` off also deletes `pointer`. `pointer: true` without frozen (stored or in the same PATCH) is `ERR_BAD_INPUT` "invalid pointer". | No hidden setting that silently comes back. | author |
| D12 | The settings dialog gets a "Screens" section with an aspect select (16:9, 16:10, 4:3, 3:2, 1:1, 9:16, plus the deck's current value first if it is another one), the frozen checkbox and the pointer checkbox (disabled unless frozen is ticked). | Pablo described freezing "the ratio"; aspect is not editable in the UI today. | user (intent), author (options) |
| D13 | The scaled iframe lives in `div.deck-virtual` (fixed w×h, `position:absolute; top:0; left:0; transform-origin:0 0`, no background, no `will-change`), with offsets rounded to device pixels; overlays live in a sibling `div.deck-layer` placed over the displayed rect. | Robust structure per research; `will-change` freezes raster scale and blurs; no background keeps the presenter's end card visible. | research |
| D14 | The shell sends the scale to the bridge as an optional `scale` field of `{t:'mode'}`, only for virtual frames. The bridge sets `scale` from every `mode` message: a finite number > 0 is used, a missing or invalid one sets `scale = 1`; the swipe threshold is `60 / scale`. | Keeps the swipe at 60 screen px; non-frozen frames send exactly today's messages. | research, review |
| D15 | Pointer is a room command (`ROOM_COMMANDS`), not a deck command; positions never written to disk, logged or put in the snapshot; snapshot gains `pointer: boolean` and `layout`. | Deck commands bump `rev`, broadcast and persist. | research |
| D16 | A colour slot belongs to a device (`client.device`), allocated (lowest free integer) on the first `on` or move, freed when that device's last `kind==='presenter'` client leaves; cleared entirely when the pointer is turned off or the deck is reset. | Same unit as the presenters list; stable colour during a talk. | research |
| D17 | Server limits: `POINTER_LIMIT = [{ max: 30, ms: 1000 }]` per device on moves (over it: dropped, no reply); moves skipped for receivers with `socket.bufferedAmount > PTR_BUFFER` (16384); `off`/`clear` always sent. Client sends ≤ 15/s, latest position only. | Bounded fan-out; no stuck dots. | research |
| D18 | Fan-out: every client in `s.clients` except the sender's socket and `kind==='pending'` (participants, displays, presenter windows including the sender's other windows). | Everyone sees every pointer; parked clients are not in `s.clients`. | research |
| D19 | Dots hide on every screen when the step changes or the screen blanks; the server drops moves while blank and marks slots hidden on a step change. A dot hides after 4 s without a message, as a safety net for a lost `off`. | Avoids dots left over on the wrong content. | author |
| D20 | While the laser is on and the mouse is over the slide, the sender re-sends the last position every 1500 ms even if it did not move. No position is kept on the server: screens that join later see the dot within 1.5 s. | A pointer held still on a formula must stay visible; "never stored" rule. | review |
| D21 | Dot size on screen: `clamp(8px, 1.4% of the displayed slide width, 26px)`, set by the frame as CSS variable `--ptr-size` on `.deck-layer`; filled colour, 2 px white ring, 1 px dark outline, glow in the same colour; moves with an 80 ms linear transition on `left`/`top`. | Visible on light and dark slides, on phones and projectors; smooth at 15 Hz. | author |
| D22 | Palette (`PTR_COLORS` in `public/pointer.js`; classes `.ptr-c0`…`.ptr-c5` in CSS set both `background` and `color`): `#ff2d55`, `#ffcc00`, `#34c759`, `#0a84ff`, `#ff9500`, `#bf5af2`. | Distinct hues; CSS classes respect the CSP (`style-src 'self'`). | author, review |
| D23 | In frozen mode a click on the viewer's black bars (target is `.viewer-stage` itself) acts as a click on the deck (`onAction('next')`). | Same behaviour as clicking the slide today. | research |
| D24 | Thumbnails of frozen decks use the deck's virtual size; non-frozen thumbnails keep 1280 × height-by-aspect. | Thumbnail matches what screens show; non-frozen unchanged. | research |
| D25 | Error code `pointer-off` when a `ptr` arrives while the deck's pointer is off; malformed `ptr` → `bad-message`. | Follows `contest-off`/`hands-off` and `bad-message` conventions. | research |
| D26 | Viewers show presenters' dots only while they display the live step (`local === live.index`); stepping away clears them. | A dot on another slide's content is meaningless. | review |
| D27 | The layout reload is guarded against loops: before reloading for a layout `L`, a page stores `sd-layout-reload:<slug>` = `L` in `sessionStorage`; if that key already equals `L` when the mismatch is seen again, it does not reload and logs a console warning. A page that loads with a matching layout removes the key. `/api/decks/:slug` returns the live state's layout when the deck has a live state, so the API and the snapshot agree. | Live state is cached while deck.json can change on disk; a loop would make screens unusable. | review |
| D28 | The presenter keeps its talk timer across reloads in `sessionStorage` (`sd-timer:<slug>` = `{ start, elapsed }`). | A layout change must not reset Pablo's timer mid-class. | review |

### Tasks

#### T1 — Settings, layout key and API

- **Objective:** Decks can store `frozen` and `pointer`; the server computes
  the layout key; the API exposes `frozen`, `pointer` and `layout` to every
  page and the admin; invalid combinations are refused.
- **Files:** `src/decks.js`, `src/routes/api.js`, `src/routes/admin.js`,
  `test/decks.test.js`, `test/admin.test.js`, `test/routes.test.js`.
- **Depends on:** —
- **Details:**
  - `src/decks.js` exports:
    - `frozenOf(meta) => meta?.frozen === true`;
    - `pointerOf(meta) => frozenOf(meta) && meta?.pointer === true`;
    - `virtualSize(aspect) => { w, h }` per D5 (parse `"W:H"`; any side not
      a positive integer → `{ w: 1920, h: 1080 }`);
    - `layoutOf(meta) => frozenOf(meta) ? \`${w}x${h}\` : null` with
      `{ w, h } = virtualSize(meta.aspect)`.
  - `updateSettings(slug, { title, viewerNav, aspect, contest, frozen, pointer })`:
    `frozen`/`pointer` when given must be booleans
    (`DeckError('ERR_BAD_INPUT', 'invalid frozen' | 'invalid pointer')`).
    In the meta modification: `frozen === true` → `meta.frozen = true`;
    `frozen === false` → delete `meta.frozen` and `meta.pointer`;
    `pointer === true` requires the resulting `meta.frozen === true`, else
    `ERR_BAD_INPUT 'invalid pointer'`; `pointer === false` → delete
    `meta.pointer`. Do not touch `normalizeMeta`. `list()` rows gain
    `frozen`, `pointer` and `layout`.
  - `src/routes/api.js`: `thumb()` passes and returns `layout`; the
    `/api/decks/:slug` output gains `frozen`, `pointer` and `layout` before
    the closed-room early return (T4 makes `layout` prefer the live value).
  - `src/routes/admin.js` PATCH: read `frozen`, `pointer` from the body,
    pass them on, return `frozen`, `pointer` and `layout` in the answer.
- **Acceptance criteria:**
  - [ ] `node --test test/decks.test.js test/admin.test.js test/routes.test.js`
        passes, with new tests: `virtualSize('16:9')` → 1920×1080,
        `'4:3'` → 1920×1440, `'9:16'` → 1080×1920, `'16:0'` → 1920×1080;
        frozen on/off round trip; pointer refused without frozen (400);
        frozen off removes pointer; a deck never set keeps a deck.json
        without `frozen`/`pointer` keys after a PATCH of its title;
        `/api/decks/:slug` returns `frozen:false, pointer:false, layout:null`
        by default and `layout:"1920x1080"` once frozen.
  - [ ] The exact-shape assertions at `test/admin.test.js` (~l. 137) and
        `test/routes.test.js` (~l. 133) are updated on purpose; the defaults
        download test (~l. 222) still passes unchanged.
  - [ ] `npm test` passes.

#### T2 — Virtual frame in the shell and bridge

- **Objective:** `createDeckFrame` can render a deck at a fixed virtual size,
  scaled and letterboxed, with an overlay layer and the scale passed to the
  bridge; `deckThumb` uses it. Without `virtual`, nothing changes.
- **Files:** `public/shell.js`, `public/bridge.js`, `public/style.css`,
  `public/list.js`, `public/selector.js`, `test/e2e/frame-harness.html` (new),
  `test/e2e/server.js`, `test/e2e/frame.spec.js` (new),
  `test/e2e/bridge.spec.js`.
- **Depends on:** T1 (thumbnail rows carry `layout`)
- **Details:**
  - New exports in `public/shell.js`: `parseAspect(aspect) → [w, h]`
    (positive integers from `"W:H"`, else `[16, 9]`) and
    `parseLayout(layout) → { w, h } | null` (`/^(\d+)x(\d+)$/` with both > 0,
    else `null`). Replace the local aspect parsing in `viewer.js`,
    `presenter.js`, `editor.js` and `deckThumb` with `parseAspect`.
  - `createDeckFrame(container, deckUrl, { mode, query, swipe, virtual = null })`.
    With `virtual`: build `div.deck-virtual` (inline `style.width/height` in
    px) containing the iframe, and a `div.deck-layer` sibling; append both to
    the container; the iframe gets `allow: 'autoplay'` (D6). A
    `ResizeObserver` on the container runs `fit()`: skip when the container
    is 0×0; `s = Math.min(cw / w, ch / h)`; `x`, `y` = centring offsets
    rounded to device pixels (`Math.round(v * devicePixelRatio) / devicePixelRatio`);
    wrapper `transform = translate(x px, y px) scale(s)`; layer
    `left/top/width/height = x, y, w·s, h·s` px and
    `--ptr-size = clamp(8, 0.014 · w·s, 26) px` (D21); store `frame.scale`;
    when `s` changed and the frame is ready, `post({t:'mode', mode: frame.mode, swipe, scale: s})`.
    The three existing `mode` posts add `scale: frame.scale` only when
    `virtual` is set. New frame fields: `frame.box` (wrapper or `null`),
    `frame.layer` (layer or `null`), `frame.scale` (1 when not virtual).
    `destroy()` disconnects the observer and removes wrapper and layer.
    Styles only through `element.style` / `setProperty` (CSP).
  - `deckThumb({ cover, deckUrl, aspect, locked, layout })`: drop
    `div.thumb-live` and its private observer; call
    `createDeckFrame(box, deckUrl, { mode: 'preview', virtual })` with
    `virtual = parseLayout(layout) ?? { w: 1280, h: Math.round(1280 * ah / aw) }`
    (D24). Keep the IntersectionObserver and the `load → .loaded` logic on
    `frame.element`. Callers `public/list.js` (~l. 14) and
    `public/selector.js` (~l. 17) pass the row's `layout`.
  - `public/style.css`: replace `.thumb-live` rules with
    `.deck-virtual { position: absolute; top: 0; left: 0; transform-origin: 0 0; }`
    (no background, no `will-change`), `.deck-virtual .deck-frame { width: 100%; height: 100%; }`,
    `.thumb .deck-virtual { pointer-events: none; }`,
    `.deck-layer { position: absolute; pointer-events: none; overflow: hidden; }`.
  - `public/bridge.js`: `var scale = 1;`; in the `mode` handler
    `scale = typeof m.scale === 'number' && isFinite(m.scale) && m.scale > 0 ? m.scale : 1;`;
    swipe test `Math.abs(dx) > 60 / scale` (D14). Update the protocol comment
    at the top.
  - Test page `test/e2e/frame-harness.html`: a module script that imports
    `/_slidecast/shell.js`, a `div#box` (`position: relative`) whose size the
    test sets, and `window.mount(opts)` that calls
    `createDeckFrame(box, '/demo/', opts)` and keeps the frame in
    `window.frame`. Serve it at `/__test/frame.html` through `extraRoutes`
    in `test/e2e/server.js`, as `harness.html` is.
- **Acceptance criteria:**
  - [ ] New `test/e2e/frame.spec.js` on `/__test/frame.html`:
        - `mount({ mode: 'live', virtual: { w: 1920, h: 1080 } })` in a
          390×844 box: the deck sees `innerWidth === 1920` and
          `innerHeight === 1080` (read with `frame.evaluate(() => [innerWidth, innerHeight])`
          on the Playwright frame); `.deck-virtual` `getBoundingClientRect()`
          is 390 ± 1 wide and vertically centred ± 1 px; `.deck-layer`'s rect
          equals the iframe's rect ± 1 px;
        - resizing the box to 844×390 refits: height 390 ± 1, horizontally
          centred ± 1 px, layer still equal to the iframe rect;
        - `mount({ mode: 'live' })` (no virtual): the iframe is a direct child
          of `#box`, there is no `.deck-virtual`, `allow` still contains
          `fullscreen`, and no `mode` message posted to the iframe has a
          `scale` key (spy on `HTMLIFrameElement.prototype.contentWindow`'s
          `postMessage` from the page, or record messages in the deck with
          `frame.evaluate`);
        - with `virtual`, `allow` is `autoplay` and the deck's
          `document.documentElement.requestFullscreen()` rejects.
  - [ ] `test/e2e/bridge.spec.js` gains a case: after posting
        `{t:'mode', mode:'live', scale: 0.25}` (threshold 240 iframe px), a
        100 px swipe does *not* turn the slide and a 300 px swipe does; then
        posting `scale: -1` (and, separately, `scale: 'x'`) resets the
        threshold to 60, so a 100 px swipe turns it; without `scale` the
        existing 150 px swipe test still turns it.
  - [ ] Thumbnails in the deck list still render (existing e2e specs pass).
  - [ ] `npm run check` and `PW_DISABLE_TS_ESM=1 npx playwright test` pass.

#### T3 — Frozen mode in every view

- **Objective:** Viewer, projector, presenter (current and next), editor and
  thumbnails use the virtual frame when the deck is frozen.
- **Files:** `public/viewer.js`, `public/presenter.js`, `public/editor.js`,
  `public/style.css`, `test/e2e/frozen.spec.js` (new).
- **Depends on:** T1, T2
- **Details:**
  - Each caller passes `virtual: parseLayout(data.layout)` (viewer:
    `info.data`; presenter and editor: `deck`). The admin stage probe is
    unchanged.
  - `public/viewer.js`, frozen only: `stage.addEventListener('click', (e) => { if (e.target === stage) onAction('next'); })` (D23).
  - `public/style.css`: `.e-frame` gets `position: relative` (the wrapper is
    absolute; `.viewer-stage`, `.p-frame`, `.thumb` are already positioned).
  - Presenter end card: in `renderNext`, hide `next.box ?? next.element`
    instead of `next.element` at the end.
- **Acceptance criteria:**
  - [ ] New `test/e2e/frozen.spec.js` with a deck.json `frozen: true` written
        through `srv.dataDir` (pattern of `test/e2e/contest.spec.js` ~l. 74–88):
        - viewer at 390×844: `.deck-virtual` exists, the deck sees 1920×1080,
          the displayed rect is 390×219 ± 1 centred;
        - opening a poll shrinks the stage and the deck refits inside it
          (displayed rect inside `.viewer-stage`, ± 1 px);
        - presenter: `.p-current .deck-virtual` displayed rect equals the
          `.p-current` box ± 1 px; the end card is visible on the last step;
        - a click on a button inside a `data-interactive` element of a frozen
          fixture deck reaches the deck (assert its effect in the deck);
        - a click on the black bars of the viewer moves to the next step when
          the viewer may navigate (`viewerNav: 'free'`).
  - [ ] With `frozen` off the existing specs `viewer`, `presenter`, `editor`,
        `poll`, `contest` pass unchanged.
  - [ ] `PW_DISABLE_TS_ESM=1 npx playwright test` passes.

#### T4 — Open screens follow layout changes

- **Objective:** Changing `frozen`, or the aspect of a frozen deck, makes
  every open screen of that deck reload by itself on the live step; a screen
  that reconnects later with a stale layout reloads too; the presenter keeps
  its timer.
- **Files:** `src/live.js`, `src/routes/admin.js`, `src/routes/api.js`,
  `public/viewer.js`, `public/presenter.js`, `test/layout-live.test.js` (new),
  `test/e2e/frozen.spec.js`.
- **Depends on:** T1, T3
- **Details:**
  - `stateOf`: `layout: layoutOf(meta)`. `snapshot`: add `layout: s.layout`.
  - New API functions: `layoutOf(slug)` → the live state's layout, or
    `undefined` when the deck has no live state; `setLayout(slug, layout)`:
    no state or same value → return; else set `s.layout = layout`, `s.rev++`,
    and close every socket in `s.clients` and `s.parked` with
    `CLOSE.again, 'again'`.
  - PATCH handler: when `frozen` or `aspect` is in the body, call
    `live.setLayout(slug, layoutOf(meta))` (the decks.js `layoutOf`).
  - `resetDeck` (not removed): inside the existing `readMeta().then`, apply
    the same `setLayout` logic with `layoutOf(meta)`.
  - `src/routes/api.js` `/api/decks/:slug`: `const liveLayout = ctx.live.layoutOf(slug);`
    then `layout = liveLayout === undefined ? layoutOf(deck.meta) : liveLayout`
    (not `??`: `null` is a valid live value) (D27).
  - `public/viewer.js` and `public/presenter.js`: on every `state`, if
    `msg.layout !== loadedLayout` (both normalised to `null` when absent),
    apply D27: reload unless `sessionStorage['sd-layout-reload:' + slug]`
    already equals `String(msg.layout)`; on page load with a matching layout,
    remove that key. Wrap `sessionStorage` access in try/catch (reload
    anyway if it throws, at most once per page).
  - `public/presenter.js` status handler: `if (status === 'again') location.reload();`.
    Talk timer (D28): save `{ start: timerStart, elapsed: timerElapsed }` to
    `sessionStorage['sd-timer:' + slug]` on every start, stop and reset, and
    restore it on load (try/catch; a running timer resumes from `start`).
- **Acceptance criteria:**
  - [ ] `node --test test/layout-live.test.js`: a presenter, a display and a
        participant socket receive close code 4000 after a PATCH that turns
        frozen on; a PATCH that changes the aspect of a frozen deck closes
        them; a PATCH that changes the aspect of a non-frozen deck, or only
        the title, closes nothing; a deck update via `resetDeck` whose
        deck.json flips `frozen` closes them, one that keeps it closes
        nothing; the `state` snapshot carries `layout`; `/api/decks/:slug`
        returns the live layout when a live state exists.
  - [ ] E2E in `test/e2e/frozen.spec.js`:
        - with a presenter and a participant page open on step 3 and the
          presenter timer running, turning frozen on via PATCH reloads both;
          afterwards both show step 3, the participant keeps its name,
          `.deck-virtual` exists on both, and the timer did not restart
          from 00:00;
        - a participant page whose socket the test drops (e.g. with
          `context.setOffline(true)`) while frozen is turned on reloads by
          itself after coming back online and shows `.deck-virtual`;
        - with deck.json edited on disk to `frozen: true` but no `resetDeck`
          call, an open page does not enter a reload loop (it reloads at
          most once; the console shows the warning or no reload happens).
  - [ ] `npm test` passes.

#### T5 — Screens section in the admin settings dialog

- **Objective:** The admin can choose the aspect and turn frozen and pointer
  on and off from the deck settings dialog.
- **Files:** `public/admin.js`, `public/i18n.js`, `public/style.css` (only if
  needed), `test/e2e/admin.spec.js`.
- **Depends on:** T1, T4
- **Details:**
  - In `openSettings(d)`, after the default viewer mode and before
    `roomSettings`: `h3.settings-sub` "Screens"; `select#deck-aspect` with
    the options of D12 (selected = `d.aspect`; if `d.aspect` is not in the
    list, add it as the first option); `input#deck-frozen` checkbox +
    `frozenHint`; `input#deck-pointer` checkbox + `pointerHint`, disabled
    unless `deck-frozen` is checked, following the `describeContest`
    pattern. The PATCH body gains `aspect`, `frozen`, `pointer` (send
    `pointer: false` when frozen is unticked).
  - `public/i18n.js`, both `en` and `es`, same placeholders:
    `screensHeading` ("Screens" / "Pantallas"), `aspectSetting`
    ("Slide shape" / "Forma de la diapositiva"), `frozenSetting`
    ("Same layout on every screen" / "Misma maquetación en todas las pantallas"),
    `frozenHint` (en: "Every screen draws the deck at 1920 pixels and scales
    it, like the projector. Responsive decks lose their phone layout and the
    deck's own full-screen button stops working (F still works). Open screens
    reload when you save." / es: "Todas las pantallas dibujan la presentación
    a 1920 píxeles y la escalan, como el proyector. Las presentaciones
    adaptables pierden su versión para móvil y el botón de pantalla completa
    de la propia presentación deja de funcionar (F sigue funcionando). Las
    pantallas abiertas se recargan al guardar."), `pointerSetting`
    ("Shared pointer" / "Puntero compartido"), `pointerHint` (en: "Presenters
    show a laser dot on every screen with the P key. Needs the same layout on
    every screen." / es: "Los presentadores muestran un punto láser en todas
    las pantallas con la tecla P. Necesita la misma maquetación en todas las
    pantallas."). Update `notesSourceHint` and `outcomeSettingsIncoming`
    (both languages), which list the settings that come from deck.json, to
    include the screens settings.
- **Acceptance criteria:**
  - [ ] `test/e2e/admin.spec.js` new case: the pointer checkbox is disabled
        until frozen is ticked; saving frozen + pointer + aspect 4:3 stores
        them (re-open the dialog: values kept; GET `/api/decks/:slug` shows
        `layout: "1920x1440"`); unticking frozen saves `pointer:false`.
  - [ ] `node --test test/i18n.test.js` passes.
  - [ ] `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/admin.spec.js` passes.

#### T6 — Pointer on the server

- **Objective:** The server relays presenters' pointer messages to every
  other screen of the deck within the limits of D15–D18 and D25.
- **Files:** `src/live.js`, `src/routes/admin.js`, `test/pointer-live.test.js` (new).
- **Depends on:** T1, T4
- **Details:**
  - Constants next to `FLOOD`: `POINTER_LIMIT = [{ max: 30, ms: 1000 }]`,
    `PTR_BUFFER = 16_384`.
  - `stateOf`: `pointer: pointerOf(meta)`, `pointers: new Map()` (device key
    → `{ id, socket, shown, limit }`). `snapshot`: add `pointer: s.pointer`.
  - `roomFor`: each device entry gains `ptr: s.pointers.get(<device key>)?.id ?? null`
    (the list only goes to presenters).
  - `'ptr'` added to `ROOM_COMMANDS`; `roomCommand` dispatches
    `if (msg.t === 'ptr') return pointerCommand(s, client, msg);`.
  - `pointerCommand(s, client, msg)`:
    1. Shape: valid if `msg.on === true`, or `msg.off === true`, or
       `Number.isInteger(msg.x) && Number.isInteger(msg.y)` both in 0..10000;
       else return `false` (→ `bad-message`).
    2. `!s.pointer` → `send(client, {t:'error', code:'pointer-off'})`, return `true`.
    3. `off`: if a slot exists, `slot.socket === client` and `slot.shown` →
       `shown = false`, relay `{t:'ptr', id, off:true}`; return `true`.
    4. Get or create the slot (lowest free id, `limit: slidingLimit(POINTER_LIMIT)`);
       on creation call `roomChanged(s)`. `on` → return `true`.
    5. Move: `s.blank` → return `true`; `limit.wait(now)` → return `true`
       (drop, no reply); else `limit.hit(now)`, `slot.socket = client`,
       `slot.shown = true`, relay `{t:'ptr', id, x, y}`.
  - `relayPointer(s, from, msg, isMove)`: stringify once; for each `c` of
    `s.clients` with `c !== from && c.kind !== 'pending'`; skip when
    `isMove && c.socket.bufferedAmount > PTR_BUFFER`.
  - Close handler: if the closing client owns a shown slot, relay its `off`;
    if no other `kind === 'presenter'` client of the same device remains in
    `s.clients`, delete the slot (the existing `roomChanged(s)` then runs).
  - After `apply` in `onMessage`: if the index changed or `blank` became
    true, set `shown = false` on every slot (no message: clients hide on
    `state`).
  - API `setPointer(slug, on)`: same → return; set, `rev++`, `broadcast`;
    when turning off, `s.pointers.clear()`, relay `{t:'ptr', clear:true}` to
    all, `roomChanged(s)`. PATCH calls `live.setPointer(slug, pointerOf(meta))`
    when `pointer` or `frozen` is in the body. `resetDeck` (not removed):
    always clear slots and relay `clear`; in the `readMeta().then`, apply the
    `setPointer` logic with `pointerOf(meta)`.
- **Acceptance criteria:**
  - [ ] `node --test test/pointer-live.test.js` passes, covering:
        a presenter move reaches a participant, a display and a second
        presenter device as `{t:'ptr', id:0, x, y}` but not the sender;
        two presenter devices get ids 0 and 1, visible as `ptr` in their own
        `room` rows; the participant's messages contain no device id or name;
        `pointer-off` when the deck's pointer is off; a participant or a
        display sending `ptr` gets `forbidden`; malformed values (−1, 10001,
        1.5, strings) get `bad-message`; more than 30 moves in one second
        relay at most 30; moves while blank are not relayed; `off` relays
        once and a repeated `off` relays nothing; closing the presenter
        relays its `off` and frees the slot (a new device then gets id 0);
        `setPointer(false)` sends `{t:'ptr', clear:true}`; the `state`
        snapshot carries `pointer` but never positions.
  - [ ] `npm test` passes.

#### T7 — Pointer in the pages

- **Objective:** Presenters toggle a coloured laser and see the others' dots;
  audience and projector screens on the live step show every presenter's
  dot on the slide, also while it is held still.
- **Files:** `public/pointer.js` (new), `public/presenter.js`,
  `public/viewer.js`, `public/shell.js` (icon only), `public/i18n.js`,
  `public/style.css`, `test/e2e/pointer.spec.js` (new).
- **Depends on:** T3, T6
- **Details:**
  - `public/pointer.js` exports:
    - `PTR_COLORS` (D22) and `createPointerLayer(layer)` →
      `{ show(key, colorId, x, y), hide(key), clear() }`: one
      `span.ptr-dot.ptr-c<colorId % 6>` per key inside `layer`
      (`frame.layer`), `left = x / 100 %`, `top = y / 100 %`; remote dots use
      the slot id as key, the presenter's own dot uses the key `'self'`;
      each remote dot hides 4 s after its last message (D19); `'self'` has
      no timeout.
    - `createPointerSender(send)` → `{ move(x, y), off() }`:
      - sends at most one position every 66 ms, always the latest one
        (trailing send), and skips a position equal to the last one sent;
      - while moves keep coming or the last one is held, re-sends the last
        position every 1500 ms (D20) until `off()`;
      - `off()` cancels any pending trailing send and the keep-alive timer,
        sends `{t:'ptr', off:true}` at once, and forgets the last position,
        so the next `move()` always goes out.
  - `public/presenter.js`:
    - Toolbar button `button#laser.p-laser` with a new `laser` icon (add to
      `ICONS` in shell.js: a small filled circle with four short rays),
      placed in `.p-nav` after `btnLast`; `hidden` unless `live.pointer`
      and the page loaded with a layout; `aria-pressed` reflects the state;
      colour from `PTR_COLORS[myId % 6]` once the own `room` row's `ptr` is
      known (neutral before). Title and label key `laserPointer`
      ("Laser pointer (P)" / "Puntero láser (P)"). CSS hides `.p-laser`
      under `@media (hover: none), (pointer: coarse)` (D3).
    - Keydown: `p`/`P` (no modifiers, not in an editable field, button not
      hidden) toggles the laser, before `keyActionFromEvent`.
    - Laser on: send `{t:'ptr', on:true}`; add class `p-laser-on` to
      `currentBox`; `pointermove` on `currentBox` with
      `e.pointerType === 'mouse'` and `!live.blank`: compute the fraction
      against `current.element.getBoundingClientRect()`; outside 0..1 →
      `sender.off()` and hide `'self'`; else show `'self'` locally and
      `sender.move(Math.round(fx * 10000), Math.round(fy * 10000))`.
      `pointerleave`, laser off, `visibilitychange` hidden, blank and step
      change → `sender.off()` and hide `'self'`.
    - Messages: `ptr` → other presenters' dots on `current.layer`
      (`show`/`hide`/`clear`); `state` with a new index or `blank` → clear;
      `state` with `pointer:false` → laser off and button hidden;
      `error` `pointer-off` → laser off.
  - `public/viewer.js`: handle `ptr` before the `participant.onMessage`
    fallback and before `if (msg.t !== 'state')`; only when the page loaded
    with a layout and `frame.layer` exists; show dots only while
    `local === live.index` (D26). Clear on `state` with a new index or
    `blank`, when the viewer moves away from the live step (`show()`), and
    when the ranking overlay is shown.
  - `public/style.css`: `.ptr-dot` (absolute, `width/height: var(--ptr-size)`,
    `margin: calc(var(--ptr-size) / -2)`, round, `border: 2px solid #fff`,
    `box-shadow: 0 0 0 1px rgb(0 0 0 / .45), 0 0 10px currentColor`,
    `transition: left 80ms linear, top 80ms linear`); `.ptr-c0`…`.ptr-c5`
    set `background` and `color`; `.p-laser` pressed state;
    `.p-current.p-laser-on { cursor: none; }`. z-order: `.deck-layer` above
    the iframe and below `.blank-overlay` (z 5).
- **Acceptance criteria:**
  - [ ] New `test/e2e/pointer.spec.js` (frozen + pointer deck, presenter via
        admin cookie, participant and second presenter contexts, pattern of
        `test/e2e/contest.spec.js` ~l. 9–34; read dot positions with
        `expect.poll` because of the 80 ms transition):
        - the laser button is hidden when `pointer` is off and visible when on;
        - with the laser off, `page.mouse.move` over `.p-current` shows no dot
          on the participant page;
        - P then a move to 25 %/75 % of `.p-current` shows `.ptr-dot.ptr-c0`
          on the participant at 25 %/75 % of its `.deck-layer` ± 1.5 %, at
          1280×720 and at 390×844; in both, the participant's `.deck-layer`
          rect equals its iframe rect ± 1 px;
        - holding the mouse still for 5 s keeps the participant's dot visible;
        - a participant that joins while the mouse is held still sees the dot
          within 2 s;
        - a second presenter's dot shows with `.ptr-c1` on the participant
          and on the first presenter;
        - moving the mouse out of `.p-current` hides the dot and no `ptr`
          move frame is sent after the `off` frame; a step change hides it;
          blank hides it;
        - a participant on a past step (`viewerNav: 'back'`) shows no dot;
        - during one second of continuous mouse movement (a move every 5 ms),
          the presenter page sends at most 16 `ptr` frames (count the sent
          frames with `page.on('websocket')` → `ws.on('framesent')`).
  - [ ] `node --test test/i18n.test.js` passes; `npm run check` passes.

#### T8 — Documentation

- **Objective:** The format, security model, README and changelog describe
  frozen mode and the pointer, and the AI instructions produce frozen-friendly
  decks.
- **Files:** `docs/deck-format.md`, `site/index.html`, `docs/security.md`,
  `README.md`, `CHANGELOG.md`.
- **Depends on:** T1–T7
- **Details:**
  - `docs/deck-format.md`: rows `frozen` ("Every screen lays the deck out at
    one fixed size, 1920 on the long side from `aspect`, scaled to fit;
    responsive decks lose their phone layout; the deck's own fullscreen is
    disabled; open screens reload when it or the aspect changes" — default
    off) and `pointer` (shared laser pointer, needs `frozen`, default off);
    `aspect` row: "…and, when `frozen`, every screen". A short "Frozen decks"
    section: inside a frozen deck `innerWidth`/`innerHeight` are always the
    virtual size; what still differs per device (fonts not embedded,
    `matchMedia` on `pointer`/`hover`/`resolution`, `devicePixelRatio`
    ignores the scale, per-device widget state).
  - AI instructions (`docs/deck-format.md` and `site/index.html#ai-prompt`,
    kept identical): the stage W×H matches `aspect`, fitted with
    `min(innerWidth/W, innerHeight/H)`, centred both ways, recomputed on
    resize; layout never depends on the window (no vw/vh/dvh, no width/
    height/orientation media queries or `matchMedia`, no `screen.*`); embed
    fonts (no system or Google fonts); canvases of fixed size (e.g. 2× their
    stage size), never `innerWidth × devicePixelRatio`; never call
    `requestFullscreen`; do not bind wheel navigation; always write `aspect`.
  - `docs/security.md`: threat model row Presenter gains "show a pointer on
    everyone's screen"; a **Shared pointer (0010)** paragraph: who may send,
    what the audience receives (a small integer per presenter device and
    coordinates), off by default and only with `frozen`, limits (≤ 15/s plus
    a keep-alive every 1.5 s sent by the page, 30/s per device on the
    server, moves skipped above 16 KiB queued), memory only, never logged,
    a deck's code cannot send it.
  - `README.md`: admin settings list and the presenter keys (P).
  - `CHANGELOG.md` `[Unreleased]`: one bullet in the 0009 style naming plan
    0010, the format fields `frozen`/`pointer`, the protocol messages `ptr`,
    the `layout` field of `state` and the `scale` field of `mode`, and the
    reload on layout change.
- **Acceptance criteria:**
  - [ ] `node --test test/docs.test.js` passes (AI prompt identical in both files).
  - [ ] `grep -n "frozen" docs/deck-format.md docs/security.md README.md CHANGELOG.md`
        finds each file.
  - [ ] `npm test` passes.

### Execution

Mode: single agent. The frozen and pointer halves share `presenter.js`,
`viewer.js`, `admin.js`, `i18n.js`, `style.css`, `src/decks.js`,
`src/live.js` and the admin route, so no split into packages with disjoint
files exists. Order: T1 → T2 (riskiest: the scaled iframe) → T3 → T4 → T5 →
T6 → T7 → T8.

### Verification

- `npm test` and `npm run check` pass.
- `PW_DISABLE_TS_ESM=1 npx playwright test` passes in full (existing specs
  unchanged with `frozen` off, plus `frame`, `frozen`, `pointer` specs).
- Manual check with Pablo's deck
  propulsion course deck 3.4 (compressors)
  uploaded, frozen and pointer on: presenter on a laptop, projector window,
  a phone upright and landscape. The slide looks as before; the dot lands on
  the same word of a slide on all three and stays while held still; the
  deck's own fullscreen button does nothing and F works; text stays sharp.
- Manual check on a real iPhone (Safari): frozen viewer is sharp, taps on
  `data-interactive` widgets work, swipes do not trigger on small finger
  drift, pinch-zoom of the page still works, a locked phone that wakes up
  after a layout change reloads by itself.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Safari renders the scaled iframe blurry or heavy on phones. | Frozen decks look worse on iPhones. | Scale ≤ 1 on most screens (D5), no `will-change` (D13); manual iPhone check in Verification. |
| A canvas deck sized `innerWidth × devicePixelRatio` allocates ~1920×1080×dpr² on phones. | Memory pressure or blank canvases on old iPhones (16.7 MP limit on iOS 17). | Documented deck rule (T8); not overridden (non-goal). |
| Fonts missing on some devices change line breaks. | The dot can miss by a few characters on text. | AI instructions require embedded fonts (D9); Pablo's templates as a separate task. |
| Fan-out amplification: one move × up to ~1300 sockets. | Server CPU on a small machine. | Per-device cap 30/s (D17), buffered-amount skip, no per-move state. Accepted. |
| Reload on a layout change in the middle of a poll. | Screens flash and reconnect. | Poll and vote state live on the server; participants keep their token; the presenter keeps its timer (T4 e2e asserts both). Accepted. |
| deck.json edited on disk without a deck update leaves the live layout stale. | A reload loop, or pages on different layouts. | The API returns the live layout while a live state exists, and the sessionStorage guard stops loops (D27, T4 e2e). |
| Playwright `mouse`/`tap` inside a CSS-scaled iframe may not map as expected. | Flaky or wrong e2e assertions. | T3 asserts the effect of a real click inside the frozen deck; investigate the root cause of any flake (no retries to hide it). |

### Open questions

None.

## Implementation

Baseline (2026-11-18, commit `86fb727`): `npm test` 210 passed, 0 failed;
`PW_DISABLE_TS_ESM=1 npx playwright test` 112 passed; `npm run check` clean.

- [x] T1 — settings, layout key and API — `node --test test/decks.test.js test/admin.test.js test/routes.test.js` 54 passed (new: virtualSize, accessors, round trip, pointer refused, frozen off removes pointer, no keys after a title PATCH, API fields); `npm test` 213 passed
- [x] T2 — virtual frame in shell and bridge — `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/frame.spec.js test/e2e/bridge.spec.js` all passed (frame: 1920×1080 inside, 390 px wide centred, layer = iframe rect, refit at 844×390, scale posted; deck fullscreen `ok` without virtual and rejected with it, from a real click; no `scale` key without virtual; destroy cleans up. bridge: scale 0.25 → 100 px no turn, 300 px turns; −1 and 'x' reset to 60); full e2e 117 passed; `npm run check` clean
- [x] T3 — frozen in every view — `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/frozen.spec.js` 5 passed (phone viewer 1920×1080 inside, 390×219 centred, layer = iframe; poll refit contained in the stage; presenter current = box ± 1 px, end card shown and next hidden on last step; data-interactive click works at 390×844 and 1280×720 with Playwright and with a hand-computed mouse click; black-bar click → next in `free`); full e2e 122 passed with existing specs unchanged
- [x] T4 — layout reload — `node --test test/layout-live.test.js` 5 passed (snapshot `layout`; frozen on and a new aspect of a frozen deck close presenter, display and participant with 4000; same aspect, title only and aspect of a non-frozen deck close nothing; `resetDeck` flipping frozen closes, keeping it does not; API returns the live layout); `frozen.spec.js` 8 passed (presenter + named participant on step 3 reload, keep step, name and running timer; a deaf socket that missed the 4000 reloads on reconnect from the snapshot; API/live disagreement reloads once then warns); `npm test` 218, full e2e 125 passed
- [x] T5 — admin Screens section — `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/admin.spec.js` 9 passed (pointer disabled until frozen; frozen + pointer + 4:3 saved and kept on reopen, API `layout: "1920x1440"`; unticking frozen sends `pointer:false`, deck.json loses both keys; an aspect outside the list is offered first); `node --test test/i18n.test.js` passed
- [x] T6 — pointer on the server — `node --test test/pointer-live.test.js` 7 passed (move reaches participant, display and second device as `{t,id,x,y}` only, not the sender; ids 0/1 in own room rows; `pointer-off`; `forbidden` for participant and display; 8 malformed shapes → `bad-message`; 60 moves → ≤ 30 relayed; nothing while blank; off once, repeated off nothing; close relays off and frees the slot; step change hides; `pointer:false` → `{clear:true}`, snapshot has the flag and no positions); `npm test` 225 passed
- [x] T7 — pointer in the pages — `PW_DISABLE_TS_ESM=1 npx playwright test test/e2e/pointer.spec.js` 9 passed, and 4× repeated with `frozen`/`frame` specs (84 passed, no flake): button only with pointer on; laser off sends no frame; P + move at 25 %/75 % lands within 1.5 % at 1280×720 and 390×844 (layer = iframe ± 1 px), own dot too; 5 s hold keeps the dot, a late joiner sees it in < 2 s; second device `.ptr-c1` on participant and first presenter, button `--laser: #ffcc00`; leaving the slide hides it and no move frame follows the off (2 s wait); step change and blank hide it; past step shows none; 1 s of moves every 5 ms sends ≤ 16 frames. `npm test` 225, full e2e 136 passed; `npm run check` clean
- [x] T8 — documentation — `node --test test/docs.test.js` 2 passed (AI prompt identical in docs and site); `grep -c frozen` finds docs/deck-format.md 7, docs/security.md 1, README.md 2, CHANGELOG.md 4; `npm test` 225 passed

- [x] Final review — four independent reviewers (server and protocol, browser code, Pablo's real decks, tests and docs); fixes below, each with a regression test seen failing on a mutated copy (12 of 12 caught); `npm test` 230 passed, full e2e 142 passed, new specs × 5 at 8 workers 180 passed

Deviations:
- Review fix (server): a deck.json read that started before a saved layout or pointer change no longer applies stale values (`screenWrites` counter in `src/live.js`: `stateOf` reads again, `resetDeck` skips); a `ptr` queued before admission from a socket that closed meanwhile is ignored; a `pointer: true` stored without `frozen` is dropped on the next settings write instead of coming back with frozen (D11); `virtualSize` falls back to 1920×1080 when a side would round to 0 (`10000:1`).
- Review fix (D16 over T6): a deck update hides every dot (`{t:'ptr', clear:true}`, only when one was shown) but keeps the colour slots, so presenters keep their colours mid-talk; T6 said to clear the slots.
- Review fix (D28): the talk timer is restored only when the page is reloaded (navigation type `reload`); opening the presenter page anew starts from 00:00 and forgets the saved timer.
- Review fix (D27): without sessionStorage the layout guard only warns (the close code `again` still reloads on real changes); T4 said to reload anyway once, which looped on every load.
- Review fix (D26): the viewer also clears the dots when the deck moves itself off the live step (keys the bridge does not capture).
- Tests rewritten after review: the throttle e2e measures the gaps between sends inside the page (it flaked under load counting mouse moves); step change and blank are tested with the keyboard and a 1.5 s limit so the 4 s safety timeout cannot mask them; the timer must read ≥ 2 s after the reload.
- T7: `createPointerSender().off()` sends `{t:'ptr', off:true}` only when a position was sent since the last off (the server ignores the rest anyway), so step changes and leaving the slide with no dot shown send nothing.
- T4: the layout check lives once in `layoutGuard(slug, loaded)` in `public/shell.js`, used by `viewer.js` and `presenter.js`, instead of two copies.
- T4: the "socket dropped while frozen is turned on" e2e uses a socket that swallows its messages and close (pattern of `reconnect.spec.js`) and an `online` event, because Chromium's `context.setOffline(true)` does not close an open WebSocket. The loop case replaces `live.layoutOf` in the test server so the API and the snapshots disagree, which is the only way to reach the guard.
- T3: the widget fixture is a new extra deck in `frozen.spec.js` (the demo deck has no `data-interactive` element).
- T2: `public/list.js` and `public/selector.js` needed no change: they already pass the whole row / deck object to `deckThumb`, which now reads its `layout`.
- T2: the frame harness links `/_slidecast/style.css` (the frame needs `.deck-frame` sizes); messages to the deck are recorded inside the deck with `page.addInitScript` instead of spying on `postMessage` (the shell compares `e.source` with `contentWindow`, so a proxy would break it).
- T2: the fullscreen criterion is tested from a real mouse press in the deck, and also asserts that a non-frozen deck *can* go full screen, so the rejection is due to `allow` and not to a missing gesture.

## Results

Delivered against each goal (evidence in the ledger above):

- G1 frozen: every view (viewer, projector, presenter current and next, editor, thumbnails) uses `div.deck-virtual` at 1920 on the long side when `frozen`; non-frozen frames are unchanged (frame.spec "without virtual", all 112 baseline e2e still pass).
- G2 pointer setting: `pointer` only with `frozen` (decks.test, admin.test, admin.spec).
- G3 laser: button and P, one colour per device, dots on every screen on the live step, kept while still (pointer.spec, 12 cases).
- G4 layout follows: 4000 on change, snapshot `layout` for screens that missed it, loop guard, timer kept (layout-live.test 7, frozen.spec 11).
- G5 bandwidth: ≥ 60 ms between sends, keep-alive 1.5 s, 30/s per device on the server, buffered skip (pointer.spec, pointer-live.test).
- G6 Pablo's decks (3.4 compresores, 3.3 difusores, real copies): slide rectangle identical frozen vs unfrozen within 0.33 px at 1920×1080, 1366×768, 390×844, 844×390; no blur (sharpness ratio 0.999–1.028); the dot lands within 0.85 px of the target on all four screens (10 targets); triaxi widget, own ‹ › buttons and F work; the deck's own fullscreen is refused. Remaining, from the decks: body text uses system Calibri/Carlito, so on a device without them 10–35 % of text blocks break differently and the dot can land a line away from a word; frozen bars are black where the decks' own were white.
- G7 docs: deck-format (fields, "Frozen decks", AI prompt identical on the site), security, README, CHANGELOG.

Not delivered / known limits: the presenter toolbar wraps to two rows at 1440×900 with the laser button (it already wraps at 1366 without it); an open notes editor does not follow a layout change until reloaded (documented); P toggles the laser while a modal dialog is open, as B and the arrows already do; Safari/iOS and Firefox not run (manual checks in Verification still pending).

## Closure

- Date: 2026-11-18.
- Outcome: delivered. All goals met with automated evidence (Results); Pablo
  approved closing it and shipping.
- Still to do by hand (Verification): a session with the propulsion deck on
  the projector, a laptop and a real iPhone (Safari sharpness, taps on
  widgets, small finger drift, wake-up after a layout change).
- Follow-ups, not captured as tickets yet:
  - embed the fonts (Calibri/Carlito, the "⊗" glyph) in the propulsion
    templates, in the sistemas-de-propulsion repository;
  - keys the bridge does not capture (`I`, `?`, `E`, `O`, `H`, Escape, the
    mouse wheel) still open local overlays in decks;
  - the presenter toolbar wraps to two rows at 1440×900 with the laser
    button;
  - optionally, an open notes editor could follow layout changes.

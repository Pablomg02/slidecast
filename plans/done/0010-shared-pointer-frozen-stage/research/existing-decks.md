# Existing decks under frozen mode

Audit of the user's real decks (2026-11-18) against a per-deck opt-in "frozen"
mode: the iframe gets a fixed CSS box (virtual width 1920 or 1280, height from
deck.json `aspect`), the shell scales it with a CSS transform to fit each screen
(letterboxed), and a shared laser pointer is sent as coordinates normalised to
the iframe (0..1).

## Answer

- All four decks that run in slidecast today (propulsion 3.4 and 3.3, thesis
  ES/EN, demo, video) use the same pattern: a fixed 1600×900 stage scaled with
  `min(innerWidth/1600, innerHeight/900)` and centred in the window, recomputed
  on `resize`. `aspect` is `16:9` in every deck.json and matches the stage. No
  vw/vh/media-query reflow, no `screen.*`, no canvas sized from the window.
- Under frozen mode they render **identically** (same final on-screen size), and
  their own fit becomes exact: scale 1.2 (1920) or 0.8 (1280), translate 0, so
  the stage fills the iframe and a pointer at (x, y) of the iframe lands on the
  same stage pixel on every device.
- Today the viewer's iframe fills the window (`.viewer-stage { inset: 0 }`) and
  the deck letterboxes itself, so iframe-normalised coordinates would *not*
  match across screens of different shape. For these fixed-stage decks an
  aspect-locked box alone would already match; frozen also removes the integer
  rounding of `innerWidth/innerHeight` and covers decks that reflow.
- The only reflowing deck found is the drone-bench bundle (switches to a
  scrolling document when the window is portrait); frozen would make it
  **better**, but it has neither the native API nor `PRES`, so slidecast cannot
  drive it at all today. The XISTRA pitch deck is only source fragments (no
  index.html) and is not runnable.
- The biggest remaining threat to "same content under the pointer" is not
  geometry but **fonts**: the propulsion decks set body text in
  `Calibri, Carlito, "Segoe UI", "Helvetica Neue", Arial`, the demo and video
  decks use `system-ui`, and the thesis decks load Google Fonts from the
  network. Line breaks can differ per device whatever the box size. Next come
  local-only state (overlays opened by keys the bridge does not capture,
  per-device widgets).
- 1920 vs 1280 makes no visible difference for any audited deck (vector content
  and small bitmaps; final pixels are the product of both scales). 1920 is the
  better default: shell scale 1.0 on a 1080p projector, deck scale 1.0 for the
  1920×1080-canvas decks, and the least loss if a browser rasters the iframe at
  its own CSS size.

## Per deck

### Propulsion 3.4 Compresores

the propulsion course deck 3.4 (compressors, in the course repository)
(index.html 603 KB, 3317 lines; lines 3309-3314 are base64 images and fonts).

1. **Aspect.** deck.json `"aspect": "16:9"`; stage `#stage { width: 1600px; height: 900px; transform-origin: 0 0 }` (l. 61-62). Match.
2. **Fit.** `fit()` (l. 3238-3243): `s = Math.min(innerWidth / 1600, innerHeight / 900)`, `translate((innerWidth - 1600*s)/2, (innerHeight - 900*s)/2) scale(s)`, `addEventListener('resize', fit)`. Centred both ways. `html, body { height: 100%; overflow: hidden }` (l. 57). No vw/vh/dvh, no width media queries; the only `matchMedia` is `prefers-reduced-motion` (l. 2789).
3. **Risks under a fixed box scaled 0.2-1.5.**
   - `requestFullscreen` on `F` (l. 3258): never reached inside slidecast, the bridge swallows `f`/`F` in the capture phase before the deck's own `keydown`.
   - `#blank { position: fixed; inset: 0 }` (l. 542): covers the iframe viewport, fine in any box.
   - Overlays `#idx` (index, `overflow-y: auto`, l. 524) and `#help` open with `I`/`O`/`?`/`H`, and `E` toggles the exercise statement. The bridge's `keyAction` does not map these keys, so they reach the deck and open **on that device only**: the pointer then lands on an overlay nobody else sees. Clicking an index entry calls `go()` directly (same template as 3.3, l. 2938-2943 there), but the bridge swallows that click first and sends "next".
   - Interactive scene `triaxi` (l. 1530-1556): buttons and a `range` input in `.c4i-pan`, with `stopPropagation` on its events (l. 3050). The bridge lets them through (they match its `INTERACTIVE` selector), but the panel is not marked `data-interactive`. Its state is per device; the `BroadcastChannel` sync (l. 3041) cannot link sandboxed opaque-origin frames. The pointer lands on the same coordinates but over a different drawing.
   - Own touch handlers use `clientX` deltas > 60 px (l. 3279-3283); the bridge swallows them anyway.
   - Hover effects only (`#nav:hover`, `#idx .it:hover`, l. 73-76, 526); `mousemove` toggles cursor hiding (l. 3286). Harmless.
   - 43 inline SVGs with text sized in viewBox units: they scale with the stage.
   - Fonts: text `--font: Calibri, Carlito, "Segoe UI", "Helvetica Neue", Arial` (l. 44) is **device-dependent** (Calibri and Carlito share metrics, Helvetica Neue and Arial do not). Maths uses embedded woff2 fonts `SP Math`/`SP Sym` (l. 3315-3317), which is deterministic.
   - Smallest text 15 px (one rule, l. 531); body 17-20 px on the 1600 stage: ~4-5 px on a 390 px-wide phone, the same today.
   - Images: six JPEGs, at most 649×420 px. Resolution-bound, not affected by the virtual width.
4. **Verdict: identical.** The deck's fit becomes `scale(1.2)` with translate 0 at 1920×1080, so the stage fills the iframe exactly. The pointer lands on the same stage pixel, except where fonts or local overlays/widget state differ.
5. **1920 vs 1280.** Scale 1.2 vs 0.8 on a vector deck: no difference in the final result.

Driven by the **legacy adapter**: `window.PRES = { go, pasos, actual }` (l. 3140), changes signalled by `history.replaceState('#n')` (l. 3124).

### Propulsion 3.3 Difusores

the propulsion course deck 3.3 (diffusers, a local copy) (3084 lines) is
**byte-identical** to its standalone HTML export.
`deck.json` is also identical in both places, with `"aspect": "16:9"`.

Same template as 3.4:
- stage at l. 61;
- `fit()` at l. 3005-3009, centred, with a resize listener;
- `requestFullscreen` at l. 3025 (swallowed by the bridge);
- `#blank` fixed at l. 542;
- `PRES` at l. 2907;
- index click handler that calls `go()` at l. 2938-2943;
- touch at l. 3046-3049.

No interactive widgets (no inputs; the only buttons are `#prev`/`#next`, l. 2346).
Ten JPEGs, at most 859×687 px. Same device-dependent body font and 15 px minimum.

**Verdict: identical**, with the same caveats (fonts; `I`/`?`/`E` overlays are local). 1920 vs 1280: no difference.

### Thesis follow-up, ES and EN

the thesis follow-up decks (Spanish and English)
(index.html 146 KB and 141 KB, 1207 lines each; same structure, only the text differs).

1. **Aspect.** deck.json `"aspect": "16:9"`; `.stage { position: absolute; left: 50%; top: 50%; width: 1600px; height: 900px; transform-origin: center }` (l. 29). Match.
2. **Fit.** l. 1082-1083: `s = Math.min(innerWidth / 1600, innerHeight / 900)`, `translate(-50%,-50%) scale(s)`, with a resize listener. Centred.
   - An overview mode `fitOv` (l. 1155-1159) changes the stage height; it is only reachable with the `O` key when not embedded (l. 1168).
   - The only media query is `@media print` (l. 281).
3. **Risks.**
   - Native API (`SLIDECAST_DECK`, l. 1142), and it honours `__SLIDECAST__` (l. 1078): no own keys, clicks or `requestFullscreen` when embedded (l. 1168-1181).
   - `.speaker { position: fixed; max-height: 34vh }` (l. 265): notes panel toggled with `N`, non-embedded only.
   - `<video src="media/multisar.mp4" autoplay muted loop playsinline>` (l. 609): plays per device, so the frame differs while the position is the same. Needs `allow="autoplay"`, which is already set.
   - Fonts loaded from `fonts.googleapis.com` (l. 9-11). This breaks the "no external requests" rule, and the fallback differs per device if the fonts are blocked or offline.
   - `text-wrap: balance` (l. 300) is deterministic given the font.
   - Smallest text 13-14 px (l. 446, 458, 461), in a small comparison table: ~3 px on a phone, already so today.
   - Media bitmaps up to 1400×952 px, and a 720×1062 GIF shown 370 px wide.
4. **Verdict: identical.** At 1920×1080: `translate(-50%,-50%) scale(1.2)` around the centre gives exact fill.
5. **1920 vs 1280:** no difference.

### Verifiable Drone Bench briefing

the drone-bench project presentation

Contents: a source `deck.json` in another tool's format (`"v": 4`, `order`, `sections`, `faces`, no `aspect`), `slides/*.html` fragments on a 1920×1080 canvas (README), and an exported bundle `Verifiable Drone Bench — Complete Briefing.html` (4.5 MB, 3569 lines). There is no index.html, so it is not a slidecast deck as it stands. The bundle is what would be uploaded.

1. **Aspect.** Canvas 1920×1080 (`<meta name="hz:canvas-width" content="1920">`, l. 8-9; `deck-motion` JSON `"w":1920,"h":1080`, l. 3409). deck.json has no `aspect`; slidecast's default 16:9 would match.
2. **Fit, by window shape.** l. 3410 runtime:
   - `--deck-s = Math.min(Z.clientWidth/1920, Z.clientHeight/1080)`;
   - slides `height: 100dvh`, flex-centred, `.deck-scaler { transform: scale(var(--deck-s)) }` (CSS after l. 3408);
   - `matchMedia("(max-aspect-ratio: 1/1)")`: in a **portrait** window it leaves "stage" mode and becomes a vertically scrolling document of all 98 slides (scroll-snap). `resize` re-runs both.

   The bundled CSS also has many Tailwind width breakpoints, `100vw`/`100dvh` utilities and `@media (hover: hover)`; these appear to belong to the exporter's page chrome, not to the slides.
3. **Risks.**
   - **No `SLIDECAST_DECK` and no `PRES`** (0 matches): the bridge would post `no-deck-api`.
   - Its own input would move it by itself: wheel (not captured by the bridge), number keys `1`-`9` (not captured), and `hashchange`.
   - `F` calls `requestFullscreen` (swallowed by the bridge).
   - A CSP `<meta>` (l. 5): `script-src 'unsafe-inline'`. It sits after the injected bridge tag, so it should not block it (a meta CSP does not apply to content that comes before it). Unverified.
   - Fonts are embedded as data URLs (deterministic).
   - No canvas or video. Six PNGs of 720×1062 px and a 1.7 MB GIF.
   - Slide text ≥ 24 px on 1920 (≈ 20 px on 1600).
4. **Verdict: better (if it were drivable).** In frozen mode a portrait phone would get the stage view instead of the scrolling document, and the pointer would map. As it is, it cannot be driven by slidecast. It needs an adapter for this exporter's runtime, or re-exporting with the native API.
5. **1920 vs 1280:** 1920 equals its canvas (deck scale 1.0, no resampling); 1280 gives 0.667. Either way the final size on screen is the same.

### XISTRA pitch deck

a pitch deck from another project

Contents: `deck.json` (same `"v": 4` format as the drone source, no `aspect`) and 16 `slides/*.html` fragments with absolute positions on a 1920-wide canvas (`width:1920px`, `height:1080px`). Images point to `/_blob/<hash>`, an asset store of the authoring tool. There is no index.html, no runtime and no script.

**Not runnable in slidecast**, so it cannot be audited live. If exported with the same runtime as the drone bundle, it would behave like it (portrait → scroll document; no deck API). Text ≥ 24 px.

### slidecast demo (`examples/demo/`)

- `#stage` 1600×900, origin `0 0` (l. 11-14); deck.json `16:9`.
- `fit()` at l. 129-136 is the same centred pattern, with a resize listener.
- Native API, honours `__SLIDECAST__` (l. 115).
- No fixed elements, canvases, media or media queries. Smallest text 28 px.
- Fonts: `system-ui` stack (l. 10), device-dependent.

**Verdict: identical**; the pointer maps exactly up to font differences. 1920 vs 1280: no difference.

### Video deck (`site/video/deck/`)

- `#stage` 1600×900 (l. 11-12); deck.json `16:9`.
- `fit()` at l. 261-266 is centred, with a resize listener.
- Native API (l. 133), honours `__SLIDECAST__` (l. 140).
- Canvases have a **fixed backing store** of 1600×900 (l. 175, CSS l. 15), not window × DPR: unaffected by frozen. They are equally soft on a 4K projector either way.
- The "Find your note" slider sits in a `data-interactive` block (l. 76-80). Its state is per device by design ("everyone moves the slider on their own phone").
- Fonts: `"Inter", system-ui…` (l. 10, 19-20), not embedded, so device-dependent.

**Verdict: identical.** 1920 vs 1280: no difference (canvas pixels are fixed).

## Recommendations for the plan

- **Virtual width 1920**, height `round(1920 × h / w)` from `aspect`.
  - 16:9 gives exactly 1080, which is shell scale 1.0 on a 1080p projector.
  - It is the native canvas of the 1920-wide decks.
  - It costs the least if a browser rasters a transformed iframe at its own CSS size rather than at screen scale.
  - For non-integer heights (e.g. 21:9), rounding to whole px is harmless: the deck's own centring absorbs < 0.5 px.
  - Prior art: `deckThumb` in `public/shell.js` already renders decks in a fixed 1280-wide box scaled with `transform` (l. 166-171).
- **Normalise the pointer in the shell** against the iframe's `getBoundingClientRect()` in the parent page (which includes the transform). The bridge is not needed for the geometry.
- **Default for fixed-stage decks.** Since fixed-stage, centred decks already map exactly in any box of the deck's aspect, consider always giving the viewer an aspect-locked iframe box when the pointer is on, and keeping frozen as the opt-in that also fixes the CSS size. At minimum, the pointer must not be normalised to today's full-window viewer iframe.
- **Fullscreen.**
  - Keep fullscreen owned by the shell.
  - If a deck ever makes its iframe fullscreen, the UA stylesheet forces it to fill the screen with `transform: none`, breaking the frozen geometry on that device. Have the shell exit or ignore iframe fullscreen (`fullscreenchange` with `document.fullscreenElement === iframe`), or drop `fullscreen` from `allow` in frozen mode if no deck video needs it.
  - The bridge already swallows `F` for all audited decks.
- **Bridge thresholds.** In frozen mode the bridge's 60 px swipe threshold is measured in iframe px, i.e. ~12 screen px at scale 0.2 and 90 at 1.5. Either send the shell scale to the bridge (e.g. in the `mode` message) and divide, or detect swipes in the shell.
- **Optional: expose the scale.** Expose the shell scale to decks (e.g. `window.__SLIDECAST__.scale` plus an event), so canvas-heavy decks can size their backing store for the real on-screen size. `devicePixelRatio` inside the iframe does not include the shell's transform.
- **Changes to "Instructions for your AI assistant"** in `docs/deck-format.md`:
  - The stage is W×H px matching deck.json `aspect` (1600×900 for 16:9). Fit it with `s = Math.min(innerWidth/W, innerHeight/H)` and **centre it both ways**. Recompute on `resize`.
  - Layout must not depend on the window: all sizes in stage px. No `vw`/`vh`/`dvh`/`%` of the viewport, no media queries or `matchMedia` on width, height, aspect-ratio or orientation (only `prefers-reduced-motion`), no `screen.*`, and no "mobile layout".
  - Embed the fonts (`@font-face` with `data:` URLs or font files next to index.html); do not rely on system fonts or Google Fonts. Line breaks must be the same on every device. The thesis decks already break the existing "no external requests" rule this way.
  - Canvas backing store at a fixed multiple of its stage size (e.g. 2×), never from `innerWidth × devicePixelRatio`.
  - Do not call `requestFullscreen`.
  - When embedded, do not open menus, overlays or panels of your own with keys (index, help). Add **wheel** to the list of navigation the deck must not bind ("keyboard, click, swipe or wheel"); number keys are covered by "keyboard".
  - Remember that interactive widget state is per device.
  - Readability: no text under ~24 px on a 1600×900 stage (~6 px on a phone held upright).
  - Write `"aspect"` in deck.json, plus the new frozen flag once it has a name.
- **Legacy adapter.** It only recognises `window.PRES`, i.e. the propulsion template, which is fixed-stage and centred. It handles no deck that is *not* fixed-stage. The one reflowing deck found (the drone bundle) has no API at all. Supporting it would mean a third adapter for that exporter's runtime (`.deck-slide` sections and its `deck-motion` JSON). It should be its own ticket, not part of this plan.
- **Side findings (not caused by frozen, but they make the pointer miss).**
  - Keys the bridge does not map (`I`, `O`, `?`, `H`, `E`, `Escape`, digits) reach the deck. In the propulsion template they open local overlays; in the drone bundle digits jump slides.
  - Mouse wheel reaches the deck (the drone bundle navigates on wheel).
  - Possible fix: swallow every key except those of editable or `data-interactive` targets, and swallow `wheel` outside interactive elements. That is a separate ticket.

## Unknowns

- **Rasterisation.** Whether every target browser (Chrome on Android, Safari on iOS, Firefox) rasters a sandboxed, transformed iframe at screen scale or at its own CSS size. This decides whether 1280 could look softer than 1920 on a 4K projector. Verify with screenshots at shell scale ~0.3 and ~1.5 for both widths.
- **Integer viewport.** Whether `innerWidth`/`innerHeight` inside a fractional-size box round or truncate. This only matters for the non-frozen aspect-locked alternative, where it causes an error under 1 screen px.
- **iOS text inflation.** Whether iOS Safari applies `text-size-adjust` inflation inside a transformed iframe in landscape. The drone bundle sets `text-size-adjust: 100%`; the propulsion, thesis and demo decks do not.
- **Drone bundle CSP.** That its CSP `<meta>` does not block the bridge injected before it. Not tested in a browser.
- **Pitch deck.** How it would be exported to a runnable index.html; nothing to test today.
- **Upload path for v4 folders.** How slidecast treats a folder whose deck.json is the other tool's `"v": 4` format (no `slidecast` field). Not checked in `src/decks.js` beyond the `aspect` default (l. 86).

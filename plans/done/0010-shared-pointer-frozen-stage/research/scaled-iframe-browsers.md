# What breaks when a fixed-size sandboxed deck iframe is scaled with a CSS transform on an ancestor, per browser?

Researched 2026-11-18. Scope: the iframe has a fixed CSS size (the "virtual resolution") and sits in a wrapper with `transform: scale(s)`, in Chrome/Edge (desktop and Android), Firefox, and Safari (macOS, iOS, iPadOS).

## Answer

The setup is sound in every engine. Layout, `vw`/`vh`, `position: fixed` and width media queries inside the iframe all resolve against the fixed iframe size, so every device lays the deck out the same way. Event coordinates inside the iframe stay in the iframe's own CSS pixels, so a normalised pointer computed as `clientX / innerWidth` is identical on every device [2][13][14][18].

Three things need explicit handling:

1. **The deck's own `requestFullscreen()`.** It fullscreens the iframe element itself, in the top layer, with `transform: none !important` and `width/height: 100% !important` [1][3][4]. During fullscreen the frozen size is lost (the deck re-lays out at screen size), the wrapper's transform no longer applies, and the parent's pointer overlay is hidden under the top layer. On iPhone, element fullscreen does not exist at all [6].
2. **Safari's blur when scaling above 1.** WebKit bug 27684 is still open, with comments in 2026. Scaling down stays sharp [8][9].
3. **Canvas decks.** `devicePixelRatio` ignores transforms [13], so a canvas sized `innerWidth × dpr` costs the same on a phone at scale 0.2 as on a projector. At 1920 × 3 that is 18.7 MP. That is over the old iOS 17 limit of 16.7 MP, and about 75 MB per canvas on iOS 18 and later [15][16].

**Recommendation:** use a 1920-wide virtual resolution with height from the deck's aspect ratio, so laptops and 1080p projectors get scale ≤ 1 (sharp in Safari). Put the transform on a wrapper div, not on the iframe. In frozen mode, let `bridge.js` intercept the deck's fullscreen calls and fullscreen the parent's stage container instead. As an optional extra, let `bridge.js` override `devicePixelRatio` with an effective value (device DPR × scale) to keep canvas cost under control on phones.

## Findings

### 1. Input and hit-testing

- Per the HTML spec, a user activation inside the iframe also activates every ancestor window, with no origin check [17]. So when the bridge posts a message from a click or key handler, the parent can call `requestFullscreen()` in its message handler. slidecast already relies on this for the `f` key: `bridge.js` line 150 posts `fullscreen`, and the parent calls `toggleFullscreen()` in `shell.js` line 465.
- Coordinates inside the iframe are in the iframe's own space. `elementFromPoint` explicitly applies the transforms of the viewport's descendants [13]. In the parent, `getBoundingClientRect()` on the iframe returns the rendered (scaled) box, while `offsetWidth`/`offsetHeight` return the unscaled layout size [14]. Use the rect to map parent coordinates.
- No open bug was found for wrong click or touch coordinates under a static scale on current Chrome or Safari. Older bugs of this kind are fixed:
  - Firefox bug 1561858: wrong mouse coordinates in scaled out-of-process iframes, fixed in Firefox 69 [10].
  - WebKit bug 266523: gesture and wheel events inside an iframe ignored the iframe-to-parent transform, fixed in trunk on 2023-12-16 [11].
  - WebKit bug 128924: a 2014 iOS touch-region offset in iframes [12].
- Still open: Firefox bug 1548560. Synthesized mouse events (the hover updates fired after layout changes) do not account for CSS transforms on iframes and can target the wrong document [10b]. The impact is limited to stale hover states, not clicks.
- Since Chrome 127, desktop Chrome puts opaque-origin sandboxed iframes in a separate process (an OOPIF). On Android they are separated only when the parent uses Partial Site Isolation [19]. So on desktop Chrome, slidecast's decks are OOPIFs, and the OOPIF input and raster paths apply.
- Pinch-zoom of the parent page changes the visual viewport, not `devicePixelRatio`, which uses scale factor 1.0 [13]. `bridge.js` registers `touchstart` and `touchend` as non-passive capture listeners (`bridge.js` lines 229-230). Any `preventDefault()` on a multi-touch event there blocks pinch-zoom. This comes from reading the code, not from a browser bug.

### 2. iOS iframe auto-expansion

- iOS historically "always expanded iframes to fit their content" (Simon Fraser, WebKit bug 149264). Scrollable frames, which honour their CSS size, shipped in iOS/iPadOS 13 in 2019 [5]. WebKit then removed the frame-flattening code entirely in July 2022 (bug 242883, commit 252632@main) because it was no longer used [5b].
- So on iOS 16, 17, 18 and 26, an iframe with explicit px `width`/`height` keeps that size, whether it is sandboxed or same-origin. The `width: 1px; min-width: 100%` and `scrolling="no"` hacks date from iOS 8-11 [5c]. They are obsolete, and `min-width: 100%` would actually defeat a fixed size.

### 3. Fullscreen called from inside the iframe

- The spec's `requestFullscreen()` walks up the frame tree. The requested element and every ancestor iframe element (the container) are fullscreened and added to the top layer of their own document [1].
- The UA style sheet for `:not(:root):fullscreen` sets the following, all `!important`: `position: fixed`, `inset: 0`, `width: 100%`, `height: 100%`, `transform: none`, and min/max sizes reset. `iframe:fullscreen` also drops the border and padding. Chromium's sheet [3] and WebKit's sheet [4] match the spec.
- Effect on slidecast: the iframe element in the parent fills the screen, so the deck's viewport becomes the screen size and the frozen layout is lost. Because the iframe renders in the top layer, which is rendered as if it were a sibling of the root [2], the wrapper's `scale()` no longer applies to it. Any sibling overlay, such as the laser pointer layer, is drawn underneath and is not visible.
- On exit, the element leaves the top layer, the UA rules stop matching, and the authored size and the ancestor transform apply again. This follows from the spec's style rules [1]. No bug against it was found.
- Older WebKit had no top layer, so ancestor transforms broke fullscreen (bug 221471, 2021). The fix is WebKit bug 84796, "Implement top layer rendering bits", fixed 2021-08-19, with fullscreen moved onto the top layer in bug 84798 [7]. Current Safari behaves like the spec.
- iPhone: element fullscreen is still unsupported; only `<video>` can go fullscreen.
  - WebKit bug 206854, "Add Fullscreen API to iOS", is still NEW as of 2026-10-30.
  - A June 2026 comment says the Safari 27 beta notes do not mention it.
  - WebKit bug 212934 was closed WONTFIX in 2026-01 [6].
- iPad: the Fullscreen API has been unprefixed since Safari 16.4 [6b]. A Wikimedia report says non-video element fullscreen misbehaves on iPadOS 26 when the page sets a non-default `<meta viewport>` [6c]. That report is from a third party.
- Because user activation propagates to ancestor windows [17], the bridge can forward the deck's fullscreen request to the parent. The parent can then fullscreen its stage container, which holds both the iframe and the pointer overlay. Inside that container the wrapper simply re-fits to the screen.

### 4. Rendering quality

- **Chrome.** Composited content has been re-rastered at the "ideal" scale when its transform scale changes since 2016, unless it has `will-change: transform` [20]. For OOPIFs, the child frame's raster scale is the `compositing_scale_factor`, which "takes into account the transform from child frame space to main frame space" [21]. So text in a scaled deck is re-rastered sharply at both 0.2 and 1.5.
  - Fractional-scale fuzziness in OOPIFs has been fixed piecemeal: a raster-translation fix in July 2025 [22], and a pixel-grid snap that landed disabled behind a flag in November 2024 [23].
  - Do not put `will-change: transform` on the wrapper. In Chrome it freezes the raster scale, which blurs on upscale [20].
- **Safari.** WebKit computes a root-relative scale so that transformed layers back their content at the right scale [8b]. But WebKit bug 27684, "Composited elements appear pixelated when scaled up using transform", is still ASSIGNED, with 2024-2026 reports on macOS 15 and iPadOS 18.
  - Bugs filed as duplicates of it include iframe content under a scale > 1 (133801: blurry above 100% when the iframe plays video or has fixed-position content, but sharp at scale(1) and below) and scrolling layers inside a scaled parent (287719, Safari 18.3) [8][9].
  - A 2026 comment says `will-change: transform` does not help [8].
  - Practical rule: keep s ≤ 1 in Safari.
- **Firefox.** WebRender re-rasters under static transforms. Known blur reports involve `will-change: transform` (bug 1520126) and fractional raster roots (bug 1754809) [24].
- **`devicePixelRatio`.** It depends only on page zoom and the device, not on CSS transforms or pinch-zoom [13]. It is `[Replaceable]` in WebIDL [13], so the bridge can legitimately override it before deck scripts run.

### 5. Performance and memory on phones

- Raster memory follows the on-screen size, not the virtual size, in Chrome [20][21] and WebKit [8b]. A 1920 frame at 0.2 is rastered at about 0.2 × DPR. Layout and style cost depend on the DOM, not much on the viewport width. No source quantifies the difference; see the gaps section.
- Canvas is the real cost, because decks size canvases from `innerWidth × devicePixelRatio`:
  - iOS canvas area limits: 4096² (16,777,216 px) from 2015 until 8192² (67,108,864 px) in WebKit commit d1f63c0, March 2024 (bug 271002). A field test on BrowserStack devices sees the new limit from iOS 18.0 [15].
  - So a 1920×1080 canvas at DPR 3 (5760×3240 = 18.7 MP) fails on iOS 17 and costs about 75 MB on iOS 18+. At 1280×720 × 3 it is 8.3 MP and about 33 MB.
  - iOS also caps total canvas memory per page ("Total canvas memory use exceeds the maximum limit") [16].

### 6. Other parts of the setup

- **`vw`/`vh`/`dvh`/`svh`/`lvh` inside the iframe** resolve against the initial containing block, which is based on the iframe's viewport [18]. They are constant at the virtual size. An iframe has no dynamic browser UI, so the three viewport sizes coincide. The spec only says they are "possibly identical" [18]; the iframe-specific conclusion is an inference.
- **`position: fixed` inside the deck** is relative to the iframe's own viewport (a separate document). The parent's transform has no effect on it.
  - Caveat: in the parent, any transformed ancestor becomes the containing block for `position: fixed` descendants [2]. A pointer overlay placed inside the scaled wrapper scales with it, which is in fact desirable.
- **`matchMedia`.** Width, height and orientation queries see the virtual size and are identical everywhere. `resolution` (follows `devicePixelRatio` [13]), `pointer`, `hover` and `prefers-*` still differ per device, and a deck that branches on them can lay out differently. This follows from the definitions; no bug source.
- **`ResizeObserver`.** "Observations will not be triggered by CSS transforms" [25]. Observe the outer box and write the transform on the inner wrapper, and no loop error can occur. The thumbnail code in `shell.js` (`deckThumb`, lines 147-180) already follows this pattern.
- **`getBoundingClientRect` from the parent** includes the transform, while `offsetWidth` does not [14].

## Options compared

| Option | Pros | Cons | Fit for our constraints |
| --- | --- | --- | --- |
| **A. Wrapper div with fixed size and `transform: scale(s)`, origin `0 0`; iframe 100% of the wrapper; outer box `overflow: hidden`, centred with rounded translate** | Matches `deckThumb`. The iframe keeps a plain box, so fullscreen UA rules restore cleanly. The pointer overlay can sit inside the wrapper and share the transform. | Fixed-position overlays inside the wrapper scale too (usually wanted) | Best |
| B. `transform` directly on the iframe | One element fewer | Fullscreen forces `transform: none` on the iframe, so state is mixed. The overlay must duplicate the math. | Acceptable, worse |
| C. CSS `zoom` on the wrapper | Changes layout, not raster, so it is always sharp | The iframe's CSS size, and with it the deck's viewport, changes with zoom. In Chrome this feeds `css_zoom_factor` into the child [21]. That defeats "frozen". | Rejected |
| **Virtual width 1920** | s ≤ 1 on 1080p projectors and most laptops: sharp in Safari [8]. Matches typical authoring size. | Canvas decks at DPR 3 reach 18.7 MP (over the iOS 17 limit) [15]. Px-authored small text shrinks on phones. | Recommended, with the DPR shim |
| Virtual width 1280 | 2.25× fewer canvas pixels, under iOS limits | s ≈ 1.125-1.5 on laptops and projectors: Safari upscale blur [8][9]. Inconsistent with an authored 1080p design. | Only as a per-deck choice |
| **Fullscreen interception in `bridge.js` (wrap `Element.prototype.requestFullscreen`, `webkitRequestFullscreen`, `document.exitFullscreen`, and emulate `fullscreenElement` and `fullscreenchange`)** | Keeps the frozen size and the pointer overlay visible. Lets the parent fall back to a CSS "fake fullscreen" on iPhone [6]. | The emulation must be faithful enough for decks that check `document.fullscreenElement`. | Recommended in frozen mode only |
| `devicePixelRatio` override in `bridge.js` (device DPR × s, clamped, plus a synthetic `resize` event when s changes) | Canvas becomes sharp at s > 1 and cheap at s < 1. The `[Replaceable]` attribute makes it legal [13]. | `matchMedia('(resolution)')` disagrees with the override. Only helps decks that read the value. | Optional, frozen mode only |

Structure details for option A:
- Use `transform-origin: 0 0` and compute `s = min(W_box / W, H_box / H)`.
- Place the wrapper with `left`/`top` (or a translate) rounded to whole device pixels. That limits fractional-position fuzziness in OOPIFs [22][23].
- Give the iframe `width: 100%; height: 100%; border: 0; display: block; min-width: 0; max-width: none`.
- Give the outer box `overflow: hidden` and an explicit size.
- Do not use `will-change: transform` [20][24].
- Use the same virtual size for frozen-deck thumbnails, which use 1280 today.

## Confidence and gaps

**High** for the fullscreen behaviour, `devicePixelRatio`, ResizeObserver, frame flattening, iPhone fullscreen and the canvas limits. All of these come from specs, engine source or bug trackers dated 2022-2026.

**Medium** for:
- Input correctness. No current bug was found, but absence of evidence is not proof.
- Safari's blur at s > 1. The bug is open, but the trigger conditions vary.
- The phone layout cost of 1920 compared with a small viewport. No benchmark exists.

What would raise confidence:
- A Playwright e2e test in Chromium, Firefox and WebKit. It would click and tap known points inside a scaled sandboxed iframe at s = 0.2, 1 and 1.5, check the normalised coordinates, and take a screenshot to check sharpness.
- One real-device run on iPhone (iOS 18/26) and iPad of a canvas or WebGL deck at 1920.
- Wheel-scroll speed inside a scaled iframe (deltas are presumably in iframe pixels, so scrolling feels slower at s < 1). No source was found; this is untested.

## Sources

1. Fullscreen API Standard (requestFullscreen algorithm, §5.2 UA style sheet) — WHATWG, Living Standard updated 2026-11-13 — https://fullscreen.spec.whatwg.org/ — normative spec
2. CSS Positioned Layout Module Level 4 (top layer, containing blocks) — W3C CSSWG, WD 2025-10-07 — https://www.w3.org/TR/2025/WD-css-position-4-20251007 — normative spec
3. Chromium `fullscreen.css` UA style sheet — Chromium, HEAD (read 2026-11-18) — https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/css/fullscreen.css — engine source
4. WebKit `fullscreen.css` UA style sheet — Apple/WebKit, main (read 2026-11-18) — https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WebCore/css/fullscreen.css — engine source
5. WebKit bug 149264, "[iOS] IFrames are not scrollable even when scrolling=yes" (scrollable frames in iOS 13) — WebKit Bugzilla, 2015-2019 — https://bugs.webkit.org/show_bug.cgi?id=149264 — engine tracker, engineer comments
5b. WebKit bug 242883, "Remove frame flattening code" (252632@main) — WebKit Bugzilla, 2022-07-19 — https://bugs.webkit.org/show_bug.cgi?id=242883 — engine tracker. See also https://github.com/WebKit/WebKit/commit/37224f042c178a094cc2287dee595345bc89f687
5c. WebKit bug 149889 (iOS iframe width expansion and the `width:1px; min-width:100%` workaround era) — WebKit Bugzilla, 2015 — https://bugs.webkit.org/show_bug.cgi?id=149889 — historical tracker. Content not fetched; cited only via the search summary.
6. WebKit bug 206854, "Add Fullscreen API to iOS" (still NEW, last modified 2026-10-30), and bug 212934 (WONTFIX 2026-01-25) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=206854 and https://bugs.webkit.org/show_bug.cgi?id=212934 — engine tracker
6b. "[iOS Safari] Fullscreen API on a non-video element" — Apple Developer Forums, 2020-2025 — https://developer.apple.com/forums/thread/133248 — forum (real-world reports; the Safari 16.4 unprefixing note)
6c. Wikimedia Phabricator T390256 (iPadOS 26 element fullscreen with a custom meta viewport) — Wikimedia, 2025-2026 — https://phabricator.wikimedia.org/T390256 — third-party tracker, real-world report
7. WebKit bug 221471 (transform animation breaks fullscreen, no top layer) and bug 84796, "Implement top layer rendering bits" (fixed 2021-08-19) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=221471 and https://bugs.webkit.org/show_bug.cgi?id=84796 — engine tracker
8. WebKit bug 27684, "Composited elements appear pixelated when scaled up using transform" (ASSIGNED, last modified 2026-10-28) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=27684 — engine tracker
8b. WebKit changeset r155977 (root-relative contentsScale for transformed layers) — WebKit Trac, 2013 — https://trac.webkit.org/r155977 — engine source history (old; current code not re-read)
9. WebKit bug 133801 (iframe content blurry under scale, duplicate of 27684, 2026-09) and bug 287719 (scaled overflow scrolling blurry, Safari 18.3, 2025-02) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=133801 and https://bugs.webkit.org/show_bug.cgi?id=287719 — engine tracker
10. Mozilla bug 1561858 (mouse coordinates in scaled OOP iframes, fixed in Firefox 69) — Mozilla Bugzilla, 2019 — https://bugzilla.mozilla.org/show_bug.cgi?id=1561858 — engine tracker. Content seen only via the search summary.
10b. Mozilla bug 1548560, "Synthesized mouse events don't account for CSS transforms on elements enclosing views" (NEW) — Mozilla Bugzilla — https://bugzilla.mozilla.org/show_bug.cgi?id=1548560 — engine tracker
11. WebKit bug 266523, "Invalid coordinates on gesture (and resulting wheel) events inside iframe" (fixed 2023-12-16, 272176@main) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=266523 — engine tracker
12. WebKit bug 128924, "Shifted document touch handling in iframes on iOS" — WebKit Bugzilla, 2014 — https://bugs.webkit.org/show_bug.cgi?id=128924 — engine tracker (historical)
13. CSSOM View Module (`devicePixelRatio` steps; `[Replaceable]`; `elementFromPoint` transforms) — W3C CSSWG Editor's Draft 2026-11-05 — https://drafts.csswg.org/cssom-view/ — spec
14. "Determining the dimensions of elements" — MDN, 2025-06-10 — https://developer.mozilla.org/en-US/docs/Web/API/CSS_Object_Model/Determining_the_dimensions_of_elements — reference docs
15. WebKit bug 271002, "[iOS] Increase the limit on the canvas size to 8192x8192" (commit d1f63c0, 2024-03-15) — WebKit Bugzilla — https://bugs.webkit.org/show_bug.cgi?id=271002 — engine tracker. Field test: "Canvas is finally usable on Safari" — lionpuro, 2025-05-10 — https://lionpuro-com.pages.dev/posts/canvas-is-finally-usable-on-safari — blog, real-world measurement
16. "Total Canvas Memory Use Exceeds The Maximum Limit" — PQINA (Rik Schennink), undated — https://www.pqina.nl/blog/total-canvas-memory-use-exceeds-the-maximum-limit/ — blog, real-world. Not fetched; title only from search.
17. HTML Standard §6.4 User activation, "activation notification" — WHATWG, Living Standard (read 2026-11-18) — https://html.spec.whatwg.org/multipage/interaction.html#activation-notification — normative spec
18. CSS Values and Units Level 4 §6.1.2 viewport-percentage lengths — W3C CSSWG Editor's Draft 2026-08-24 — https://drafts.csswg.org/css-values-4/#viewport-relative-lengths — spec
19. "Process Model and Site Isolation" (sandboxed iframes isolated on desktop since 127.0.6483.0) — Chromium docs, HEAD (read 2026-11-18) — https://chromium.googlesource.com/chromium/src/+/HEAD/docs/process_model_and_site_isolation.md — engine docs
20. "Intent to ship: re-rastering composited layers on scale change" — Chris Harrelson, blink-dev, 2016-06-11 — https://groups.google.com/a/chromium.org/g/blink-dev/c/Ufwrhx_iZ7U — engine intent (still the documented behaviour)
21. Chromium `visual_properties.h` (`compositing_scale_factor`, `css_zoom_factor`) — Chromium, HEAD (read 2026-11-18) — https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/public/common/widget/visual_properties.h — engine source
22. "Fixed raster translation for OOPIFs" — Olga Gerchikov (Microsoft), Chromium commit, 2025-07-30 — https://chromium.googlesource.com/chromium/src/+/d283a465cd615caa51d758a222cf6b2d43f1514c — engine source
23. "Tweak SurfaceLayerImpl DrawQuad transform for pixel-alignment" (flag `AlignSurfaceLayerImplToPixelGrid`, disabled) — W. James MacLean, Chromium commit, 2024-11-07 — https://chromium.googlesource.com/chromium/src/+/570f87d82f2588a125f9a19f0430989ffb7db05d%5E%21 — engine source
24. Mozilla bugs 1520126 (will-change: transform blurry text, WebRender) and 1754809 (fractional raster root blur) — Mozilla Bugzilla — https://bugzilla.mozilla.org/show_bug.cgi?id=1520126 and https://bugzilla.mozilla.org/show_bug.cgi?id=1754809 — engine tracker. Content seen only via the search summary.
25. Resize Observer — W3C CSSWG Editor's Draft 2022-11-22 — https://drafts.csswg.org/resize-observer/ — spec

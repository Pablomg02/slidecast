# The author's existing HTML decks ("legacy PRES engine")

Source: the author's private repository `sistemas-de-propulsion`
(`contenido/01-Apuntes/Editable/*/Tema_*.html` and the template
`contenido/98-Plantillas/html-clase/plantilla_clase.html`), read on 2026-10-23.
The implementer cannot access it; this note is the reference. Do not copy
any of that content into this public repository: build synthetic fixtures.

## Shape

- One self-contained `index.html` per deck, 0.2–1.4 MB, with every image inlined
  as base64. No `fetch`, no `localStorage`, no external scripts.
- A fixed 1600×900 stage `#stage`, scaled to the window by the deck itself:
  `s = min(innerWidth/1600, innerHeight/900)`, then `translate(...) scale(s)`,
  re-run on `resize`. Works unchanged inside an iframe of any size.
- Slides are `<section class="scene" id="<scene-id>" data-section="..." data-ref="...">`
  inside `#stage`. The active one gets class `active`.
- Steps inside a scene come from attributes on descendants:
  `data-in="k"` (visible from step k), `data-out="k"` (hidden from step k),
  `data-go="k"` (adds `.go` from step k), `data-hl="2-4,6"` (adds `.on` in those
  steps). A scene's step count is `max(all k) + 1`, or set by JS scenes.
- `const ORDEN = ['portada', 'hilo', ..., ['camara', [0, 2]]]` lists the order.
  A string means "all steps of that scene"; `[id, [steps]]` means only those
  steps, so a scene id can appear several times.
- The engine flattens ORDEN into `SEQ = [{id, k}, ...]`. Navigation is a single
  integer index `cur` into SEQ (0-based).

## Public surface the adapter can rely on

```js
window.PRES = {
  go: i => go(i, { jump: true }),   // jump to SEQ index i (clamped)
  pasos: SEQ.map(s => s.id + ':' + s.k),  // e.g. ["portada:0", "hilo:0", "hilo:1", ...]
  js: [...],                        // ignore
  actual: () => cur,                // current SEQ index
};
```

- `window.PRES` is assigned synchronously when the engine script runs; the first
  `go(fromHash())` happens on `DOMContentLoaded`.
- Every change calls `history.replaceState(null, '', '#' + (i + 1))` (1-based).
  `replaceState` does not fire `hashchange`, so change detection must wrap
  `history.replaceState` (or poll `PRES.actual()`).
- On `hashchange` the deck jumps to the hash index.

## Input handling inside the deck (what the bridge must neutralise)

- `keydown` on `window` (bubble phase): ArrowRight/ArrowDown/PageDown/Enter/Space
  → next (Shift+Space → prev); ArrowLeft/ArrowUp/PageUp/Backspace → prev;
  Home/End → first/last; `f` fullscreen; `b`/`B`/`.` toggles its own `#blank`;
  `i`/`o` index overlay; `?`/`h` help overlay; Escape closes overlays.
- `click` on `#stage` → next step, except clicks inside `#nav` or overlays.
- `#prev` / `#next` buttons inside `#nav` call prev/next directly.
- `touchstart`/`touchend` on `#stage`: horizontal swipe > 60 px → next/prev.
- URL params it reads: `?static` (disables animations; useful for previews) and
  `?t=ms` (freezes animations, for screenshots).

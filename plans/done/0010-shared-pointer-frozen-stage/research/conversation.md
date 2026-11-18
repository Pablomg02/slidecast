# Design conversation with Pablo (2026-11-18)

Summary of the discussion that shaped plan 0010, in the order it happened.

## The request

Pablo wants everyone (audience devices and the projector) to see where his
mouse is when he moves it and points in the presenter view.

## Bandwidth

- A position is one tiny WebSocket message (`{"t":"ptr","x":4123,"y":5521}`),
  about 90 bytes per viewer on the wire with WS/TCP/IP overhead.
- At 15 messages per second, only while the mouse moves: about 0.5 Mbit/s for
  50 viewers, 3 Mbit/s for 300, 13 Mbit/s at the 1200-socket cap
  (`WS_LIMITS` in src/live.js). Nothing is sent while the mouse is still.
- Requirements that keep it cheap: a separate message outside the snapshot
  (`broadcast()` sends the whole state), throttling on the presenter, viewers
  smoothing the dot with a short CSS transition, the server dropping stale
  positions for slow sockets, and a laser mode so moving the mouse to press a
  button sends nothing.

## Why coordinates are the hard part

- The deck runs in a sandboxed iframe; the slide's position inside it depends
  on how each deck lays itself out at each viewport size.
- `aspect` in deck.json is only a ratio ("16:9"), never a resolution. It
  shapes the box in the presenter view, the editor and the thumbnails; the
  audience iframe fills the whole screen and the deck letterboxes itself.
- On a phone held upright (390×844) a fixed-stage deck draws a 390×219 16:9
  band in the middle; the iframe still covers the whole screen.
- A web page lays out by its width in pixels, not by its ratio: the same 16:9
  ratio at 1920 and at 390 pixels wide reflows text, columns and media queries
  differently. Fixing only the ratio is enough for fixed-stage decks such as
  Pablo's propulsion decks, not for responsive ones.

## The idea that works for every deck: a virtual resolution

- Every view renders the iframe at the same fixed CSS size (a virtual
  resolution derived from the aspect), and the shell scales it with a CSS
  transform to fit each screen, letterboxed. The deck believes its window is
  always that size, so it lays out identically everywhere, like an image seen
  at different sizes.
- Then the pointer is simply a fraction of the iframe and lands on the same
  content on every screen.
- Cost: a responsive deck loses its phone layout and shows the desktop layout
  small. Fixed-stage decks look the same as today.
- slidecast does not enforce fixed dimensions today; the fixed 1600×900 stage
  is only a recommendation in docs/deck-format.md.

## Pablo's design

- A deck setting to **freeze** the layout for everyone (the aspect applied to
  all, at a virtual resolution). Default: **off**.
- A deck setting to enable the **pointer**; it can only be on when the deck is
  frozen.
- **No pointer from phones** (touch); mouse on the presenter page only.
- **Several presenters: one colour each**, because it is no more complex than
  a "take the pointer" token (no shared state, no take/give commands). The
  token design was the fallback if colours were too complex.

## Alternatives discussed and set aside

- Contain-fit rectangle computed by the shell assuming the deck centres
  itself: works only for fixed-stage, centred decks with a correct aspect.
- Measuring the real stage inside the iframe from bridge.js: more robust for
  fixed-stage decks, still wrong for responsive ones.
- Anchoring the pointer to elements (element path + offset): works with
  responsive decks but much more complex.
- Highlighting the element under the mouse instead of a dot: robust but
  coarser; not chosen.

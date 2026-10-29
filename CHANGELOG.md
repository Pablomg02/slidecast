# Changelog

All notable changes to slidecast. Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
include breaking changes, always listed here.

## [Unreleased]

- Presenter view on a computer: drag the dividers between the slide, the
  next slide and the notes to resize them (a taller next slide widens its
  column). The sizes are remembered; double-click a divider for the original
  layout. A divider reached with Tab also moves with the arrow keys.
- Hold an arrow key (or any next/previous key) down to move through the
  slides quickly, up to ten steps a second. A held `B` or `F` still toggles
  only once.
- Clickers: `F5`, sent by the "start" button of many clickers, toggles full
  screen instead of reloading the page, and the next/previous track media
  keys move the slides too.
- Presenter view, for the admin: **Edit notes**, next to **Open viewer**,
  opens the notes editor in a new tab at the slide and step being presented.
  The editor takes `?slide=<id>&step=<k>` for that.
- Rooms can be **Open**, **Hidden** or **Closed**. A hidden room is open but
  reached only through its link: it is not listed and the main address never
  goes to it. With a single deck, the room can be hidden too, and the main
  address then shows the page asking for the link.
- Removed: the **Open only this one** button, and the `only` field of
  `PATCH /api/admin/rooms/:slug`.
- Admin panel: a wider deck table, with each deck's links on one line and
  its buttons on the next, instead of a cramped Actions column.

## [0.2.2] - 2026-10-25

- Admin panel: **Download** a deck as one `.zip` with its files and its
  notes (`deck.json`), ready to upload again.
- Admin panel: **Update** a deck with a new version, keeping notes by slide
  id. Before anything changes it shows which notes are kept and which are
  deleted (slides or steps the new version no longer has), and, when the zip
  brings its own `deck.json`, asks which notes (and settings) to use. An ⓘ
  button explains the rules. Uploading over an existing name in the upload
  form now opens this update instead of replacing silently.

- Viewer: when nobody with a presenter session is connected (presenter
  view, or a viewer tab of a presenter, controlling or not), a small notice
  says so. It can be closed, and goes away by itself when a presenter
  comes back.
- Deck settings: the "Close" button stays in view at the bottom of the
  dialog while its content scrolls.

## [0.2.1] - 2026-10-25

- Viewer on a phone: "Back to live" no longer covers the name and
  raise-hand buttons; it sits above them, and steps aside while the hand
  note is open.
- Viewer modes have clearer names ("Follow the presenter", "Can go back",
  "Browse freely"), and the deck settings explain what each one allows.
- Viewer: trying to move where the mode does not allow (any move in
  "Follow the presenter", ahead of the presenter in "Can go back") shows a
  short notice instead of doing nothing.
- Deck settings: "Save" is now "Save changes", and the passwords below it
  sit after a double rule under their own heading, since each one is saved
  with its own button.

## [0.2.0] - 2026-10-25

- Rooms: each deck is a room the admin opens and closes, from the admin
  panel or the presenter view; "Open only this one" closes the others. Rooms
  start closed, viewers of a closed room wait and join by themselves when it
  opens, and closing a room forgets everyone in it. `/` follows the open room
  (with several open, the list of them). **Breaking:** the "Home page"
  setting is gone, and the public list is now on by default and shows only
  open rooms.
- Viewers give a name that only presenters see, or join anonymously
  ("Participant 007"), and can raise their hand with a short note.
  Presenters see raised hands and the people in the room in new tabs next to
  the notes: queue, attend (the viewer is told), resolve, lower all, turn
  hands off; remove a viewer (a reload does not bring them back) or stop
  admitting new people. The admin can remove another presenter's device.
- Per-deck room settings: presenters at once (devices, 1–20, 20 by default),
  viewers at once (1–1000, 200 by default), ask for names, allow hands.
- WebSocket limits: 500 connections per address (was 100) and 1 200 in total
  (was 1 000), plus 100 kept for presenters. Viewers no longer receive every
  join and leave, only changes of the slide state.

## [0.1.1] - 2026-10-24

- Swiping on a slider or inside `data-interactive` no longer changes slides on
  touch screens; swipes elsewhere on the slide still do.
- Appearance: the "Made with Slidecast" credit shows the logo, and a new
  setting hides the logo next to the site name. Turning the credit off no
  longer leaves "null" on the home, deck and not-found pages.
- Docker Compose starts without `deploy/.env`, as the Raspberry Pi guide
  does before the tunnel token exists.
- markdown-it 15 for speaker notes (fixes several slow-parsing cases); links
  without a scheme, like `example.com`, are still turned into links.
- fflate, only used by the tests, no longer ships in Pi and Docker installs.
- Website at <https://pablomg02.github.io/slidecast/>, in English and
  Spanish, with a demo video.
- CI builds the Docker image and checks it the way the Raspberry Pi guide
  uses it; two viewer tests no longer fail on slow CI machines.

## [0.1.0] - 2026-10-24

First public release.

- Presenter view: current and next step, speaker notes, timer, clock and a
  blackout button; works on a phone as a remote.
- Viewers follow the presenter live over WebSocket, with three modes per deck
  (follow, may go back, free) switchable during the talk.
- Clicker support, including from the projector's computer (*Controlling*).
- Admin panel: upload (`.html` or `.zip`), replace, rename and delete decks,
  edit Markdown notes stored in `deck.json`, passwords, home page behaviour
  and appearance (site name, home message, accent colour, credit).
- Decks run in a sandboxed iframe; scrypt password hashes, login rate limits,
  CSRF and cross-site WebSocket protection.
- Runs locally (`start.sh`), on a local network, through Tailscale or
  Cloudflare Tunnel, and on a Raspberry Pi with an install script or Docker
  Compose.
- English and Spanish interface.

[Unreleased]: https://github.com/Pablomg02/slidecast/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Pablomg02/slidecast/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Pablomg02/slidecast/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Pablomg02/slidecast/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Pablomg02/slidecast/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Pablomg02/slidecast/releases/tag/v0.1.0

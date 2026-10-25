# Changelog

All notable changes to slidecast. Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
include breaking changes, always listed here.

## [Unreleased]

- Viewer on a phone: "Back to live" no longer covers the name and
  raise-hand buttons; it sits above them, and steps aside while the hand
  note is open.
- Viewer modes have clearer names ("Follow the presenter", "Can go back",
  "Browse freely"), and the deck settings explain what each one allows.
- Viewer: trying to move where the mode does not allow (any move in
  "Follow the presenter", ahead of the presenter in "Can go back") shows a
  short notice instead of doing nothing.
- Deck settings: the main button now says what it saves (title, mode and
  room); passwords sit under their own heading and keep their own buttons.

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

[Unreleased]: https://github.com/Pablomg02/slidecast/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Pablomg02/slidecast/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Pablomg02/slidecast/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Pablomg02/slidecast/releases/tag/v0.1.0

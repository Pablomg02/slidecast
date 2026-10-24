# Changelog

All notable changes to slidecast. Versions follow
[Semantic Versioning](https://semver.org); before 1.0, a minor version may
include breaking changes, always listed here.

## [Unreleased]

- markdown-it 15 for speaker notes (fixes several slow-parsing cases); links
  without a scheme, like `example.com`, are still turned into links.
- Fix two viewer tests that could fail on slow CI machines.

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

[Unreleased]: https://github.com/Pablomg02/slidecast/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pablomg02/slidecast/releases/tag/v0.1.0

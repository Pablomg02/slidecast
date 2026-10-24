# Contributing to slidecast

Thanks for your interest. Bug reports, ideas, documentation fixes and pull
requests are all welcome. For security problems, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## Before you start

- **Bugs**: open an [issue](https://github.com/Pablomg02/slidecast/issues/new/choose)
  with the bug template. A minimal deck that shows the problem helps a lot.
- **Small fixes** (typos, clear bugs, a missing translation): open a pull
  request directly.
- **New features or larger changes**: open an issue first, so we can agree on
  the approach before you spend time on it.

Issues and pull requests may be written in English or Spanish.

### What fits slidecast

slidecast tries to stay small and easy to run anywhere, from a laptop in class
to a Raspberry Pi. Changes are most likely to be accepted when they keep that:

- **A deck is a folder with an `index.html`** and an optional `deck.json`
  ([deck format](docs/deck-format.md)). No build step, no special framework
  for deck authors.
- **No database, no accounts, no cloud service, no tracking.** State lives in
  a few JSON files in the state folder.
- **Few dependencies.** Prefer the Node.js standard library; a new runtime
  dependency needs a good reason. The browser code has no build step and no
  framework: plain ES modules in `public/`.
- **Security is not optional.** Decks are untrusted (AI-generated or
  downloaded) and run sandboxed; see [docs/security.md](docs/security.md)
  before touching authentication, sessions, uploads, the deck iframe or the
  WebSocket.

The main design decisions and their reasons are in the *Decisions* table of
[plans/done/0001-syncdeck-v1/plan.md](plans/done/0001-syncdeck-v1/plan.md)
(D1, D2… are referenced from code comments). The project was called
*syncdeck* back then.

## Setting up

You need [Node.js](https://nodejs.org) 20 or newer and git.

```bash
git clone https://github.com/Pablomg02/slidecast.git
cd slidecast
npm install
node bin/slidecast.js serve examples/demo   # http://127.0.0.1:4321
```

Your own decks go in `./decks` and server state in `./.slidecast`; both are
git-ignored, so you can test with real decks without committing them.

## Where things are

| Path | What |
| --- | --- |
| `bin/slidecast.js`, `src/cli.js` | Command line: `serve`, `passwd`, `new`. |
| `src/server.js` | Fastify app: wires the routes, WebSocket and static files. |
| `src/routes/` | HTTP routes: shell pages, public API, admin API. |
| `src/live.js` | Live state per deck and the WebSocket protocol. |
| `src/auth.js`, `src/tokens.js`, `src/security.js` | Passwords, sessions, deck tokens, CSRF and security headers. |
| `src/decks.js`, `src/deckfiles.js`, `src/unzip.js` | Deck folders, serving their files, uploads. |
| `src/config.js`, `src/store.js`, `src/appearance.js` | Settings and atomic JSON storage. |
| `public/pages/*.html` + `public/*.js` | The pages (presenter, viewer, admin…), one script each. |
| `public/shell.js` | Shared browser code: API calls, WebSocket, deck iframe, keys. |
| `public/bridge.js` | Injected into every deck; runs inside the sandbox and talks to the shell. |
| `public/i18n.js` | Every UI string, in English and Spanish. |
| `examples/demo/` | The demo deck, also the reference for the deck API. |
| `deploy/` | Raspberry Pi install scripts, systemd unit, Docker Compose. |
| `test/*.test.js`, `test/e2e/` | Unit/integration tests (`node:test`) and browser tests (Playwright). |

## Tests

```bash
npm run check                     # syntax check of every .js file
npm test                          # unit and integration tests
npx playwright install chromium   # once (on Linux add --with-deps if it asks for libraries)
npm run test:e2e                  # browser tests, start their own server
```

CI runs all of them on every pull request (unit tests on Node 20 and 22).
Please add or update tests with your change: a bug fix comes with a test that
fails without it.

Some tests guard things that are easy to forget:

- `test/i18n.test.js`: every UI string exists in both languages with the same
  `{placeholders}`.
- `test/docs.test.js`: the deck API example in `docs/deck-format.md` is
  exactly the code in `examples/demo/index.html`. Change both together.

## Conventions

- **Code style**: there is no linter or formatter. Match the surrounding
  code: ES modules, two-space indentation, single quotes, semicolons, short
  comments that explain *why*.
- **UI text**: never hard-code strings in pages or scripts. Add a key to
  `public/i18n.js` in both `en` and `es`; if you don't speak Spanish, write
  your best attempt and say so in the pull request.
- **Documentation**: if you change what a user sees or does (commands,
  options, keys, admin settings, the deck format), update `README.md` or the
  page in `docs/` in the same pull request.
- **Compatibility**: Node.js 20 is the minimum, so don't use APIs only newer
  versions have (for example, the global `WebSocket`). In the browser, target
  current versions of Chrome, Firefox and Safari, including on phones.
- **No personal data**: don't commit real decks, passwords, `.slidecast`
  folders, hostnames or tunnel tokens.

## Pull requests

- One topic per pull request; keep unrelated refactors out.
- Commit messages: a short summary in the imperative, optionally prefixed by
  the area, like the existing history (`Admin: phone layout…`,
  `README: restore…`).
- Fill in the pull request template; CI must pass before merging.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE) of the project.

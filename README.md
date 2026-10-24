# syncdeck

> **En español:** syncdeck sirve presentaciones HTML de un solo archivo con
> vista de presentador (notas, siguiente paso, cronómetro) y vista de
> espectador sincronizada: el proyector, tu móvil como mando y los portátiles
> del público siguen el mismo paso. Funciona en tu portátil con un comando o en
> una Raspberry Pi publicada con Cloudflare Tunnel. La interfaz está en español
> e inglés. Las instrucciones de instalación (en tu ordenador, en tu red o
> Tailscale, y en una Raspberry Pi con Cloudflare Tunnel) están en
> *Getting started*.

syncdeck serves single-file HTML presentations with PowerPoint-style
presenter and audience views. The presenter moves through the deck with the
keyboard, a clicker or a phone; every viewer (the projector, students'
laptops) follows the same step within a second. Speaker notes live next to the
deck in `deck.json` and are edited in the browser.

It is built for decks generated with AI: a deck is just a folder with an
`index.html`, optionally a `deck.json`, and its assets.

## What it does

- **Class, one laptop.** `syncdeck serve my-deck`; one tab in presenter mode,
  another on the projector in viewer mode. No setup, no passwords.
- **Phone as a remote.** On a Raspberry Pi behind Cloudflare Tunnel: open the
  presenter view on your phone (password), the classroom PC shows the viewer.
- **Students follow along.** They open the public link and join as viewers;
  you choose whether they are locked to your step, may look back, or browse
  freely.
- **New deck from anywhere.** Sign in to `/admin`, upload a deck, write the
  speaker notes step by step in the browser.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer and a copy of this
repository:

```bash
git clone https://github.com/Pablomg02/syncdeck.git
cd syncdeck
npm install
```

Pick the case that fits.

### 1. On your own computer (one screen, or laptop + projector)

```bash
./start.sh
```

It starts syncdeck and opens `http://127.0.0.1:4321/admin` in your browser;
press Ctrl+C (or close the window) to stop it. Upload a deck there (a
`.zip` or `.html`).
Then open the deck: choose **Presenter** in one window and **Viewer** in
another (drag that one to the projector and press `F`). On this computer
no password is needed. To try it first with the demo deck:
`node bin/syncdeck.js serve examples/demo`.

### 2. From other devices on your network or Tailscale (phone as a remote, students on the same Wi-Fi)

Set a presenter password (8+ characters, a letter and a digit) once, and
listen on the network:

```bash
node bin/syncdeck.js passwd presenter
./start.sh --network
```

The command prints the addresses to use from the other devices, e.g.
`http://192.168.1.20:4321/<deck>/present` on your phone (it asks for the
password) and `/<deck>/view` for everyone else. To manage decks from another
device too, set an admin password: `node bin/syncdeck.js passwd admin`. If
nothing connects, check that your firewall allows TCP port 4321.

### 3. On a Raspberry Pi, on the Internet through Cloudflare Tunnel

On the Pi run:

```bash
curl -fsSL https://raw.githubusercontent.com/Pablomg02/syncdeck/main/deploy/install.sh | sudo bash
```

It installs everything, asks for the passwords, and starts syncdeck as a
service on `http://localhost:4321`. Then create a tunnel in the Cloudflare
dashboard (Zero Trust → Networks → Tunnels), install `cloudflared` on the Pi
with its token, and point your hostname to `http://localhost:4321`. Step by
step, Docker and hardening tips:
[docs/deploy-raspberry.md](docs/deploy-raspberry.md).

### Updating

- Cases 1 and 2: `git pull && npm install`, then start it again.
- Case 3: `sudo syncdeck-update` (it backs up the settings, restarts, and goes
  back to the previous version by itself if the new one fails).

### Forgot a password?

Passwords cannot be read back; set a new one on the machine running syncdeck
with `node bin/syncdeck.js passwd admin` (or `presenter`); add `--clear` to
remove it. On the Pi, see the guide.

### Making decks

A deck is a folder with an `index.html` (and its assets). Start one with
`node bin/syncdeck.js new my-talk`; the format and a prompt for your AI
assistant are in [docs/deck-format.md](docs/deck-format.md).
`npm install -g .` makes the `syncdeck` command available everywhere.

## Roles and URLs

| URL | Who | What |
| --- | --- | --- |
| `/` | everyone | Opens the deck chosen to open at `/`, or the only deck. Otherwise the list of decks (if enabled) or a page asking for the link. A signed-in admin always gets the list. |
| `/<deck>` | everyone | Choose viewer or presenter. |
| `/<deck>/view` | viewers | The deck, full window, following the live step. |
| `/<deck>/present` | presenter | Current and next step, notes, timer, clock, controls. Works on a phone. |
| `/admin` | admin | Upload and delete decks, what `/` shows, passwords, settings. |
| `/admin/edit/<deck>` | admin | Notes editor. |

Passwords: an **admin** password, a **presenter** password (for every deck,
or per deck), and an optional per-deck **viewer** password. On the machine
running syncdeck, without passwords, you are presenter and admin; from any
other device (including through Cloudflare Tunnel) the role is refused until a
password is set. Set them with `syncdeck passwd` or in the admin panel.

## Keys

| Key | Action |
| --- | --- |
| → ↓ Space PageDown Enter | Next step |
| ← ↑ Shift+Space PageUp Backspace | Previous step |
| Home / End | First / last step |
| B or . | Blank every viewer's screen (and back) |
| F | Full screen |
| L | Viewer: back to the live step |

Most presentation clickers send PageUp/PageDown and `B`/`.`, so they work
out of the box. If the viewer window on the projector has the focus and that
browser may present (on the machine running syncdeck without a presenter
password, or after signing in as presenter), it shows a *Controlling* badge and
the clicker drives the presentation from there too. Its *Stop controlling*
button turns that window into a plain viewer (and *Control* back).

## Viewer modes

Chosen per deck (`viewerNav` in `deck.json`, or the admin panel) and switchable
live from the presenter view (changing it in the admin panel also applies at
once):

- **Follow**: viewers always show the presenter's step.
- **May go back** (default): viewers can look at earlier steps, never ahead;
  a *Back to live* button (or `L`) returns.
- **Free**: viewers can browse the whole deck.

## Admin panel

At `/admin`: upload a deck as a `.zip` (with `index.html` at the root or in a
single top folder) or as one `.html` file; replacing a deck keeps its notes.
Delete (moved to a trash folder, never erased), choose what `/` shows (one
deck, the list of decks, or a page asking for the link), set passwords, change a deck's title or
default viewer mode, and open the notes editor.

## CLI

```
syncdeck serve [path] [--data dir] [--state dir] [--host h] [--port p] [--trust-proxy] [--open]
syncdeck passwd admin | presenter [--deck slug [--viewer]] [--clear] [--state dir]
syncdeck new <slug> [--data dir]
syncdeck --help | --version
```

- `serve <folder with index.html>` serves only that deck (single-deck mode);
  `serve <folder>` serves every deck inside it. Default: `./decks`.
- Server state (password hashes, sessions, live step) goes to `./.syncdeck`.
  Both folders are git-ignored. When `./.syncdeck` would end up inside the
  deck being served (`cd my-deck && syncdeck serve .`), the state goes to
  `~/.config/syncdeck` instead (`%APPDATA%\syncdeck` on Windows), and an
  existing `./.syncdeck` there is moved.
- `--trust-proxy` is for Cloudflare Tunnel. Behind another proxy, make sure it
  overwrites `Cf-Connecting-IP` and `X-Forwarded-For`, or clients can choose
  their own address for the login limits.
- Default address `127.0.0.1:4321`. `--host 0.0.0.0` makes it reachable on
  your network and prints the LAN URLs.
- Environment variables mirror the flags: `SYNCDECK_HOST`, `SYNCDECK_PORT`,
  `SYNCDECK_DATA`, `SYNCDECK_STATE`, `SYNCDECK_TRUST_PROXY=1`.

## Documentation

- [Deck format](docs/deck-format.md): folder layout, `deck.json`, the deck
  API, and a prompt for your AI assistant.
- [Deploying on a Raspberry Pi with Cloudflare Tunnel](docs/deploy-raspberry.md):
  one-command install (`deploy/install.sh`) and updates (`sudo syncdeck-update`).
- [Security](docs/security.md): threat model, measures, reporting issues.

## Development

```bash
npm test                          # unit and integration tests
npx playwright install chromium   # once
npm run test:e2e                  # browser tests
npm run check                     # syntax check
```

## License

MIT, see [LICENSE](LICENSE).

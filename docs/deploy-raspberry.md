# Deploying syncdeck on a Raspberry Pi with Cloudflare Tunnel

This guide puts syncdeck on a Raspberry Pi (4 or 5, 64-bit Raspberry Pi OS) and
publishes it at `https://slides.example.com` through Cloudflare Tunnel. Nothing
is opened on your router: the Pi connects out to Cloudflare.

Replace `slides.example.com` with your own hostname everywhere below.

There are two ways to run it. Pick one:

- **A. Docker Compose**: syncdeck and `cloudflared` as two containers.
- **B. systemd**: Node.js and `cloudflared` installed on the Pi itself.

## Before you expose anything: passwords

syncdeck refuses presenter and admin access through a proxy until a password
is set (only requests made on the Pi itself, not through the tunnel, are
allowed without one). Set both passwords **before** you open the tunnel:

- admin password: uploads decks, edits notes, changes settings;
- presenter password: drives the presentation from your phone or laptop.

The commands are given in each option below. Passwords need 8 characters or
more. They are stored as scrypt hashes in the state folder (`config.json`),
never in plain text. Changing one signs out everyone who used the old one.

## Option A: Docker Compose

1. Install Docker: `curl -fsSL https://get.docker.com | sh`, then log out and in
   after `sudo usermod -aG docker $USER`.
2. Get the code and prepare the data folders (the container runs as uid 1000):

   ```bash
   git clone https://github.com/Pablomg02/syncdeck.git
   cd syncdeck/deploy
   mkdir -p data/decks data/state
   sudo chown -R 1000:1000 data
   ```

3. Start syncdeck and set the passwords:

   ```bash
   docker compose up -d --build
   docker compose exec syncdeck node bin/syncdeck.js passwd admin
   docker compose exec syncdeck node bin/syncdeck.js passwd presenter
   ```

   The running server notices the change within a couple of seconds.

4. Create the tunnel in the Cloudflare dashboard (Zero Trust → Networks →
   Tunnels → Create a tunnel → Cloudflared). Copy its token into
   `deploy/.env` (this file is not tracked by git; keep it private):

   ```
   TUNNEL_TOKEN=<the token Cloudflare shows>
   ```

   In the tunnel's *Public hostname* tab add `slides.example.com` with service
   `http://syncdeck:4321` (the container name on the compose network).

5. Start the tunnel: `docker compose --profile tunnel up -d`.

Decks live in `deploy/data/decks/`, server state in `deploy/data/state/`.

## Option B: systemd

1. Install Node.js 22 LTS so that `node` is at `/usr/bin/node` (Raspberry Pi
   OS packages or NodeSource):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. Install syncdeck in `/opt/syncdeck` with a dedicated user:

   ```bash
   sudo useradd --system --home /var/lib/syncdeck --shell /usr/sbin/nologin syncdeck
   sudo git clone https://github.com/Pablomg02/syncdeck.git /opt/syncdeck
   cd /opt/syncdeck && sudo npm ci --omit=dev
   sudo mkdir -p /var/lib/syncdeck/decks /var/lib/syncdeck/state
   sudo chown -R syncdeck:syncdeck /var/lib/syncdeck
   ```

3. Set the passwords (as the service user, so the files keep the right owner):

   ```bash
   sudo -u syncdeck node /opt/syncdeck/bin/syncdeck.js passwd admin --state /var/lib/syncdeck/state
   sudo -u syncdeck node /opt/syncdeck/bin/syncdeck.js passwd presenter --state /var/lib/syncdeck/state
   ```

4. Install and start the service:

   ```bash
   sudo cp /opt/syncdeck/deploy/syncdeck.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now syncdeck
   curl http://127.0.0.1:4321/health   # {"status":"ok"}
   ```

5. Install `cloudflared` and create the tunnel from the command line:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create syncdeck
   cloudflared tunnel route dns syncdeck slides.example.com
   ```

   Write `/etc/cloudflared/config.yml` (use the id and credentials file that
   `tunnel create` printed):

   ```yaml
   tunnel: <tunnel id>
   credentials-file: /etc/cloudflared/<tunnel id>.json
   ingress:
     - hostname: slides.example.com
       service: http://localhost:4321
     - service: http_status:404
   ```

   Then `sudo cloudflared service install` and
   `sudo systemctl enable --now cloudflared`.

The unit already passes `--trust-proxy`: syncdeck then reads the visitor's
address from `Cf-Connecting-IP` (for the login rate limit) and marks cookies
`Secure` because Cloudflare reports HTTPS.

## Using it

- `https://slides.example.com/admin` — sign in, upload decks (a `.zip` with
  `index.html`, or a single `.html`), write notes, choose the featured deck.
- `https://slides.example.com/` — visitors are sent to the featured deck (or
  to the only deck). Share `https://slides.example.com/<deck>/view` with the
  audience.
- `https://slides.example.com/<deck>/present` — the presenter view, on your
  phone or laptop.

## Backups

Everything worth keeping is in two folders:

- the decks folder (`deploy/data/decks/` or `/var/lib/syncdeck/decks/`), with
  each deck's `deck.json` (your notes);
- `config.json` in the state folder: password hashes, settings and the secret
  that signs deck links. Keep this file private.

`sessions.json` and `live.json` in the state folder can be lost without harm
(people sign in again; the live step restarts at the beginning). Deleted and
replaced decks are kept in `trash/` inside the state folder until you remove
them.

## Updating

- Docker: `git pull && docker compose up -d --build` in `deploy/`.
- systemd: `cd /opt/syncdeck && sudo git pull && sudo npm ci --omit=dev &&
  sudo systemctl restart syncdeck`.

## Forgot the admin password

Passwords are stored as one-way hashes, so nobody can read them back, not
even on the Pi. Set a new one there instead (the running server applies it
within a couple of seconds and signs out the old sessions):

- Docker: `docker compose exec syncdeck node bin/syncdeck.js passwd admin`
- systemd: `sudo -u syncdeck node /opt/syncdeck/bin/syncdeck.js passwd admin --state /var/lib/syncdeck/state`

Add `--clear` to remove it instead. Without an admin password the panel works
only on the Pi itself; from your laptop you can still reach it through SSH,
which counts as local: `ssh -L 4321:localhost:4321 pi@<the Pi>` and then open
`http://localhost:4321/admin` (systemd option; with Docker, publish the port to
`127.0.0.1` first).

## Troubleshooting

- *"No presenter password is configured…"* when presenting through the
  tunnel: set one (see above). Without passwords only the Pi itself may present.
- Viewers stop following after a while: check that the tunnel is up; the
  pages reconnect by themselves and show a *Reconnecting…* badge meanwhile.
- `journalctl -u syncdeck -f` (systemd) or `docker compose logs -f syncdeck`
  show the server log.

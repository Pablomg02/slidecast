# Deploying slidecast on a Raspberry Pi with Cloudflare Tunnel

This guide puts slidecast on a Raspberry Pi (4 or 5, 64-bit Raspberry Pi OS) and
publishes it at `https://slides.example.com` through Cloudflare Tunnel. Nothing
is opened on your router: the Pi connects out to Cloudflare.

Replace `slides.example.com` with your own hostname everywhere below.

There are three ways to set it up. Pick one:

- **Install script** (recommended): one command does option B for you,
  except the tunnel, which you add with two more commands.
- **A. Docker Compose**: slidecast and `cloudflared` as two containers.
- **B. systemd**: Node.js and `cloudflared` installed on the Pi itself, by hand.

## Install script

1. On the Pi:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Pablomg02/slidecast/main/deploy/install.sh | sudo bash
   ```

   It installs Node.js 22 and git; clones slidecast into `/opt/slidecast`;
   creates the `slidecast` user and `/var/lib/slidecast`; asks for the admin and
   presenter passwords; installs and starts the service; and checks that
   slidecast answers on `http://127.0.0.1:4321`. Running it again is safe: it
   skips what is already done.
2. In the Cloudflare dashboard create a tunnel (Zero Trust → Networks →
   Tunnels → Create a tunnel → Cloudflared) and copy its token. On the Pi,
   install `cloudflared` and run it as a service with that token:

   ```bash
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared
   sudo cloudflared service install <the token>
   ```

3. In the tunnel's *Public hostname* tab add `slides.example.com` with service
   `http://localhost:4321`.

To update later:

```bash
sudo slidecast-update
```

It fetches the latest `main` from GitHub, copies the state folder to
`/var/lib/slidecast/backups/` (keeps the last 5), installs the new version,
restarts it and checks that it answers. If the new version does not start,
it goes back to the previous one by itself and says so.
`sudo slidecast-update --force` reinstalls and restarts even when there is
nothing new. `cloudflared` is a separate package: `sudo apt-get upgrade`
updates it.

The rest of this guide describes the manual options and what the script sets
up.

## Before you expose anything: passwords

slidecast refuses presenter and admin access through a proxy until a password
is set (only requests made on the Pi itself, not through the tunnel, are
allowed without one). Set both passwords **before** you open the tunnel:

- admin password: uploads decks, edits notes, changes settings;
- presenter password: drives the presentation from your phone or laptop.

The commands are given in each option below. Passwords need 8 characters or
more, with at least one letter and one digit. They are stored as scrypt hashes in the state folder (`config.json`),
never in plain text. Changing one signs out everyone who used the old one.

## Option A: Docker Compose

1. Install Docker: `curl -fsSL https://get.docker.com | sh`, then log out and in
   after `sudo usermod -aG docker $USER`.
2. Get the code and prepare the data folders (the container runs as uid 1000):

   ```bash
   git clone https://github.com/Pablomg02/slidecast.git
   cd slidecast/deploy
   mkdir -p data/decks data/state
   sudo chown -R 1000:1000 data
   ```

3. Start slidecast and set the passwords:

   ```bash
   docker compose up -d --build
   docker compose exec slidecast node bin/slidecast.js passwd admin
   docker compose exec slidecast node bin/slidecast.js passwd presenter
   ```

   The running server notices the change within a couple of seconds.

4. Create the tunnel in the Cloudflare dashboard (Zero Trust → Networks →
   Tunnels → Create a tunnel → Cloudflared). Copy its token into
   `deploy/.env` (this file is not tracked by git; keep it private):

   ```
   TUNNEL_TOKEN=<the token Cloudflare shows>
   ```

   In the tunnel's *Public hostname* tab add `slides.example.com` with service
   `http://slidecast:4321` (the container name on the compose network).

5. Start the tunnel: `docker compose --profile tunnel up -d`.

Decks live in `deploy/data/decks/`, server state in `deploy/data/state/`.

## Option B: systemd

1. Install Node.js 22 LTS so that `node` is at `/usr/bin/node` (Raspberry Pi
   OS packages or NodeSource):

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. Install slidecast in `/opt/slidecast` with a dedicated user:

   ```bash
   sudo useradd --system --home /var/lib/slidecast --shell /usr/sbin/nologin slidecast
   sudo git clone https://github.com/Pablomg02/slidecast.git /opt/slidecast
   cd /opt/slidecast && sudo npm ci --omit=dev
   sudo mkdir -p /var/lib/slidecast/decks /var/lib/slidecast/state
   sudo chown -R slidecast:slidecast /var/lib/slidecast
   ```

3. Set the passwords (as the service user, so the files keep the right owner):

   ```bash
   sudo -u slidecast node /opt/slidecast/bin/slidecast.js passwd admin --state /var/lib/slidecast/state
   sudo -u slidecast node /opt/slidecast/bin/slidecast.js passwd presenter --state /var/lib/slidecast/state
   ```

4. Install and start the service:

   ```bash
   sudo cp /opt/slidecast/deploy/slidecast.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now slidecast
   curl http://127.0.0.1:4321/health   # {"status":"ok"}
   ```

5. Install `cloudflared` and create the tunnel from the command line:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create slidecast
   cloudflared tunnel route dns slidecast slides.example.com
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

The unit already passes `--trust-proxy`: slidecast then reads the visitor's
address from `Cf-Connecting-IP` (for the login rate limit) and marks cookies
`Secure` because Cloudflare reports HTTPS.

## Extra protection at Cloudflare (recommended)

slidecast limits password attempts by itself, but Cloudflare can stop most
automated traffic before it reaches the Pi. Both steps are done in the
Cloudflare dashboard; nothing changes in slidecast.

**1. Cloudflare Access in front of the admin panel.** Visitors to the admin
pages must first sign in with Cloudflare (for example a one-time code sent to
your e-mail), and only then see slidecast's own admin password.

- Zero Trust → Access → Applications → *Add an application* → *Self-hosted*.
- Add two destinations on `slides.example.com`: path `admin` and path
  `api/admin` (the panel's API must be covered too, not only the page).
- Policy: *Allow*, rule *Emails* → your address. Login method: *One-time PIN*
  (or your Google / GitHub account).

Presenter and viewer pages stay outside Access, so the audience needs no
Cloudflare account.

**2. A bot check on the sign-in pages.** Security → WAF → Custom rules →
*Create rule*, action **Managed Challenge**, with this expression (*Edit
expression*):

```
(http.request.uri.path eq "/admin")
or (http.request.uri.path eq "/api/login")
or (http.request.uri.path wildcard r"/*/login")
or (http.request.uri.path wildcard r"/*/present")
```

People see Cloudflare's "verifying you are human" check, usually without
clicking anything; scripts that guess passwords do not get through. If a
sign-in ever answers *Something went wrong (403)*, reload the page so the
check runs again.

**Watching failed sign-ins.** Every wrong password is logged as
`login failed` with the visitor's address, and 20 failures in an hour from one
address block it for the rest of that hour (`login locked`):

```bash
journalctl -u slidecast | grep -E "login (failed|locked)"
```

(With Docker: `docker compose logs slidecast | grep -E "login (failed|locked)"`.)

## Using it

- `https://slides.example.com/admin` — sign in, upload decks (a `.zip` with
  `index.html`, or a single `.html`), write notes, open the room you are
  about to present (rooms start closed).
- `https://slides.example.com/` — visitors are sent to the open room. Share
  this address, or `https://slides.example.com/<deck>/view`, with the
  audience.
- `https://slides.example.com/<deck>/present` — the presenter view, on your
  phone or laptop.

## Backups

Everything worth keeping is in two folders:

- the decks folder (`deploy/data/decks/` or `/var/lib/slidecast/decks/`), with
  each deck's `deck.json` (your notes);
- `config.json` in the state folder: password hashes, settings and the secret
  that signs deck links. Keep this file private.

`sessions.json` and `live.json` in the state folder can be lost without harm
(people sign in again; the live step restarts at the beginning). Deleted and
replaced decks are kept in `trash/` inside the state folder until you remove
them.

## Updating

- Docker: `git pull && docker compose up -d --build` in `deploy/`.
- Install script or systemd: `sudo slidecast-update` (or by hand:
  `cd /opt/slidecast && sudo git pull && sudo npm ci --omit=dev &&
  sudo systemctl restart slidecast`).

## Forgot the admin password

Passwords are stored as one-way hashes, so nobody can read them back, not
even on the Pi. Set a new one there instead (the running server applies it
within a couple of seconds and signs out the old sessions):

- Docker: `docker compose exec slidecast node bin/slidecast.js passwd admin`
- systemd: `sudo -u slidecast node /opt/slidecast/bin/slidecast.js passwd admin --state /var/lib/slidecast/state`

Add `--clear` to remove it instead. Without an admin password the panel works
only on the Pi itself; from your laptop you can still reach it through SSH,
which counts as local: `ssh -L 4321:localhost:4321 pi@<the Pi>` and then open
`http://localhost:4321/admin` (systemd option; with Docker, publish the port to
`127.0.0.1` first).

## Troubleshooting

- *"Presenting is not available from this device yet"* when presenting
  through the tunnel: set a presenter password (see above). Without passwords only the Pi itself may present.
- Viewers stop following after a while: check that the tunnel is up; the
  pages reconnect by themselves and show a *Reconnecting…* badge meanwhile.
- `journalctl -u slidecast -f` (systemd) or `docker compose logs -f slidecast`
  show the server log.

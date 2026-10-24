# Access from other networks

On its own, slidecast is reachable from your computer and, with
`--network`, from devices on the same Wi-Fi (see the
[README](../README.md#getting-started)). This guide is for everything else:
your phone on mobile data, an audience following from home, a classroom
network that blocks connections between devices, or a server that is always
on.

## Which option?

| You want to… | Use | Needs |
| --- | --- | --- |
| Use **your own devices** (laptop + phone) from anywhere | [Tailscale](#tailscale-your-own-devices) | A free Tailscale account |
| Share a **public link** for one talk, from your computer | [Cloudflare quick tunnel](#cloudflare-quick-tunnel-a-public-link-in-one-command) | Nothing (no account) |
| Have a **fixed address** on your own domain, from your computer | [Cloudflare Tunnel with your domain](#cloudflare-tunnel-with-your-own-domain) | A free Cloudflare account and a domain |
| Keep slidecast **always on**, without your laptop | [Raspberry Pi](deploy-raspberry.md) | A Raspberry Pi, a Cloudflare account and a domain |

None of them requires opening ports on your router.

## Before you start: passwords

From any device other than the computer running slidecast, presenting and
the admin panel are closed until you set their passwords. Set them once, on
the computer running slidecast (8 characters or more, at least one letter and
one digit):

```bash
node bin/slidecast.js passwd presenter
node bin/slidecast.js passwd admin      # only if you will manage decks remotely
```

Viewers need no password. To keep a deck private, give it a viewer password
in the admin panel (deck **Settings**).

## Tailscale: your own devices

[Tailscale](https://tailscale.com) builds a private network between your
devices, wherever they are: your phone on mobile data can reach your laptop
as if both were on the same Wi-Fi. Nobody else can reach slidecast, so it is
the safest option, but it is meant for your devices, not for an audience.

1. Install Tailscale on the computer that runs slidecast and on your phone
   (or other devices), and sign in with the same account on all of them.
2. Start slidecast for the network:

   ```bash
   ./start.sh --network
   ```

   (On Windows: `npm start -- --host 0.0.0.0`.)
3. slidecast prints several addresses. The one starting with `100.` is the
   Tailscale one; you can also see it in the Tailscale app. On your phone
   open `http://100.x.y.z:4321/<deck>/present`.

With MagicDNS turned on in Tailscale (it is by default), the computer's name
works too: `http://my-laptop:4321/<deck>/present`.

To let a few specific people in, you can share your computer with them from
the Tailscale admin console; they need their own Tailscale account. For a
larger audience use Cloudflare Tunnel.

## Cloudflare Tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
gives slidecast a public `https://` address. A small program, `cloudflared`,
runs next to slidecast and connects out to Cloudflare; visitors reach
Cloudflare, which passes the traffic through that connection. Your computer
stays hidden and nothing is opened on your router.

Anyone with the link can open it, so the passwords above matter here.
slidecast never treats a visitor coming through the tunnel as local, even
though `cloudflared` runs on the same computer.

### Install cloudflared

- **Windows**: `winget install --id Cloudflare.cloudflared`
- **macOS**: `brew install cloudflared`
- **Linux**: see Cloudflare's
  [downloads page](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (packages for Debian/Ubuntu, Red Hat and others).

### Start slidecast for a tunnel

Behind the tunnel, slidecast must be started with the `--trust-proxy` option
so it sees each visitor's real address (used to limit password guessing) and
knows the connection is HTTPS:

```bash
SLIDECAST_TRUST_PROXY=1 ./start.sh
```

On Windows: `npm start -- --trust-proxy`.

Do not add `--network`: the tunnel connects from the same computer.

### Cloudflare quick tunnel: a public link in one command

No account needed. With slidecast running as above, open a second terminal
and run:

```bash
cloudflared tunnel --url http://localhost:4321
```

After a few seconds it prints an address like
`https://random-words-here.trycloudflare.com`. Share
`https://random-words-here.trycloudflare.com/<deck>/view` with your audience,
and open `…/<deck>/present` on your phone.

Keep in mind:

- The address changes every time you start the tunnel.
- It works only while your computer is on and both terminals are open.
- Cloudflare offers quick tunnels for testing, without guarantees. For
  regular use, set up a tunnel with your own domain.

### Cloudflare Tunnel with your own domain

A fixed address such as `https://slides.example.com`. You need a free
Cloudflare account and a domain whose DNS is managed by Cloudflare.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com) go to
   **Zero Trust → Networks → Tunnels → Create a tunnel**, choose
   **Cloudflared**, give it a name, and copy the token it shows.
2. On your computer, connect the tunnel:

   ```bash
   cloudflared tunnel run --token <the token>
   ```

   The dashboard also shows the command to install it as a service instead,
   so it starts with your computer.
3. In the tunnel's **Public hostname** tab add your hostname (for example
   `slides` on `example.com`) with service type `HTTP` and URL
   `localhost:4321`.
4. Start slidecast with `--trust-proxy` as above and open
   `https://slides.example.com/admin`.

The tunnel stays configured: next time, start slidecast and `cloudflared`
again and the same address works.

For extra protection (an e-mail check in front of the admin panel, a bot
check on the sign-in pages), see
[Extra protection at Cloudflare](deploy-raspberry.md#extra-protection-at-cloudflare-recommended);
it applies to a tunnel on your computer just the same.

### Always on: a Raspberry Pi

If you do not want to depend on your laptop, slidecast runs well on a
Raspberry Pi 4 or 5 with a tunnel to your domain. One command installs it
as a service that starts by itself and updates with `sudo slidecast-update`:
see [Deploying on a Raspberry Pi](deploy-raspberry.md).

## Troubleshooting

- **"Presenting is not available from this device yet"** (or the same for
  the admin panel): set that password (see [Before you start](#before-you-start-passwords)).
- **The page loads but the slides do not follow**: check that `cloudflared`
  (or Tailscale) is still connected. Pages reconnect by themselves and show
  *Reconnecting…* meanwhile.
- **Tailscale address does not answer**: make sure slidecast was started with
  `--network` and that both devices show as connected in the Tailscale app.

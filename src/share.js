import { networkInterfaces } from 'node:os';

// The join screen (0011): which address the screens show for the audience.

export const MAX_AUDIENCE_URL = 100;

// The admin's "address for the audience" (D4): an http(s) origin, with its
// scheme, no path. Returns {value} (null to clear) or {error}.
export function parseAudienceUrl(v) {
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string' || v.length > MAX_AUDIENCE_URL) return { error: 'bad-audience-url' };
  let u;
  try {
    u = new URL(v.trim());
  } catch {
    return { error: 'bad-audience-url' };
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password
    || u.pathname !== '/' || u.search || u.hash || !/^https?:\/\//i.test(v.trim())) {
    return { error: 'bad-audience-url' };
  }
  return { value: u.origin };
}

// A name only this computer reaches: what a phone in the room cannot open.
export function isLoopbackName(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h)
    || h === '[::1]' || h === '::1' || h === '0.0.0.0' || h === '[::]' || h === '::';
}

// Bridges and VPNs the audience is never on (Docker, virtual machines, tunnels).
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|podman|cni|flannel|kube|zt|tailscale|utun|tun|tap|wg)/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// This computer's IPv4 addresses on the local network, private ones first.
export function lanAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...out.filter((ip) => PRIVATE.test(ip)), ...out.filter((ip) => !PRIVATE.test(ip))];
}

// The origin the audience types (D3): the admin's address; else the one
// this screen opened slidecast at, unless only this computer reaches it
// (localhost); else this computer's address on the local network, when the
// server listens there. null when there is none to show.
// `origin`: the screen's own (its WebSocket's Origin, checked against Host);
// `listen`: the server's {address, port}; `lan`: () => addresses.
export function audienceBase({ configured = null, origin = null, listen = null, lan = lanAddresses }) {
  if (configured) return configured;
  let u = null;
  try { u = new URL(origin); } catch { /* none or not a URL */ }
  if (u && (u.protocol === 'http:' || u.protocol === 'https:') && !isLoopbackName(u.hostname)) return u.origin;
  if (!listen || typeof listen.address !== 'string') return null;
  const any = listen.address === '0.0.0.0' || listen.address === '::';
  if (!any && isLoopbackName(listen.address)) return null;
  const ip = any ? lan()[0] : listen.address;
  if (!ip) return null;
  try {
    return new URL(`http://${ip.includes(':') ? `[${ip}]` : ip}:${listen.port}`).origin;
  } catch {
    return null;
  }
}

// What the screen shows and what its QR code opens.
export function joinLinks(base, slug) {
  if (!base) return { url: null, text: null };
  return { url: `${base}/${slug}/view`, text: `${base.replace(/^https?:\/\//, '')}/${slug}` };
}

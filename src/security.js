// CSRF / cross-site WebSocket defence (D12) and security headers.

export const SHELL_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "frame-src 'self'", "connect-src 'self'", "frame-ancestors 'self'", "base-uri 'none'",
  "form-action 'self'",
].join('; ');
export const ADMIN_CSP = SHELL_CSP.replace("frame-ancestors 'self'", "frame-ancestors 'none'");

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// True when the Origin header names the host the request was sent to.
export function originMatches(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

export function setShellHeaders(reply, { admin = false } = {}) {
  reply.header('Content-Security-Policy', admin ? ADMIN_CSP : SHELL_CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  if (admin) reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
}

export function registerSecurity(app) {
  // text/plain is a "simple" content type a cross-site form can send: drop it.
  app.removeContentTypeParser('text/plain');

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') && !SAFE_METHODS.has(req.method) && !originMatches(req)) {
      return reply.code(403).send({ error: 'bad-origin' });
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
}

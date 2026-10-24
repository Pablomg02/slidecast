// Cosmetic settings the person running the server can change from /admin:
// site name, home page text, accent colour, the logo by the name and the
// "made with" credit.
// Nothing here changes behaviour, only how the shell pages look.

export const REPO_URL = 'https://github.com/Pablomg02/slidecast';

export function defaultAppearance() {
  return { siteName: null, landingText: null, accent: null, showLogo: true, showCredit: true };
}

const LIMITS = { siteName: 60, landingText: 300 };
const HEX = /^#[0-9a-f]{6}$/i;

// Validates a partial update. Returns the cleaned fields, or null when any
// field is invalid. Empty strings and null reset a field to its default.
export function parseAppearance(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'siteName' || key === 'landingText') {
      if (value === null || value === '') out[key] = null;
      else if (typeof value === 'string' && value.trim().length <= LIMITS[key]) out[key] = value.trim() || null;
      else return null;
    } else if (key === 'accent') {
      if (value === null || value === '') out.accent = null;
      else if (typeof value === 'string' && HEX.test(value)) out.accent = value.toLowerCase();
      else return null;
    } else if (key === 'showLogo' || key === 'showCredit') {
      if (typeof value !== 'boolean') return null;
      out[key] = value;
    } else {
      return null;
    }
  }
  return out;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The page with the site name in <title> (so it shows before any script runs),
// the settings in a <meta> for shell.js (the CSP allows no inline script) and,
// with a custom accent, the theme stylesheet.
export function applyAppearance(html, look) {
  const name = escapeHtml(look.siteName || 'Slidecast');
  const meta = `<meta name="slidecast-appearance" content="${escapeHtml(JSON.stringify(look))}">`;
  const theme = look.accent ? '\n<link rel="stylesheet" href="/_slidecast/theme.css">' : '';
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace('</head>', `${meta}${theme}\n</head>`);
}

// The accent drives every other accent token; dark mode gets a lighter tint,
// as the built-in palette does. `accent` is a validated #rrggbb.
export function themeCss(accent) {
  if (!accent) return '';
  return `:root {
  --accent: ${accent};
  --accent-hover: color-mix(in srgb, ${accent} 85%, black);
  --accent-soft: color-mix(in srgb, ${accent} 12%, transparent);
  --bg-glow: color-mix(in srgb, ${accent} 10%, transparent);
}
@media (prefers-color-scheme: dark) {
  :root {
    --accent: color-mix(in srgb, ${accent} 70%, white);
    --accent-hover: color-mix(in srgb, ${accent} 55%, white);
    --accent-soft: color-mix(in srgb, ${accent} 18%, transparent);
    --bg-glow: color-mix(in srgb, ${accent} 10%, transparent);
  }
}
`;
}

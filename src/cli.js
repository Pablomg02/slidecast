import { parseArgs } from 'node:util';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { buildServer } from './server.js';
import { loadConfig, saveConfig } from './config.js';
import { readJson, writeJsonAtomic } from './store.js';
import { applyPasswordHash, checkPasswordInput, hashPassword, revokeScope } from './auth.js';
import { isValidSlug, slugFromFolder } from './decks.js';
import { ROOT_DIR, EXAMPLES_DIR } from './paths.js';

const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version;

const HELP = `slidecast ${VERSION} — synced HTML presentations

Usage:
  slidecast serve [path] [options]   Serve a deck folder or a folder of decks
  slidecast passwd <kind> [options]  Set or clear a password
  slidecast new <slug> [--data dir]  Create a deck from the demo template
  slidecast --help | --version

serve:
  [path]            A folder with index.html (single-deck mode) or a folder of
                    decks (default: --data)
  --data <dir>      Decks folder (default ./decks, env SLIDECAST_DATA)
  --state <dir>     Server state: config, sessions (default ./.slidecast, env SLIDECAST_STATE;
                    ~/.config/slidecast when ./.slidecast would be inside the deck)
  --host <host>     Address to listen on (default 127.0.0.1, env SLIDECAST_HOST);
                    0.0.0.0 makes it reachable on your network
  --port <port>     Port (default 4321, env SLIDECAST_PORT)
  --trust-proxy     Behind Cloudflare Tunnel (env SLIDECAST_TRUST_PROXY=1); other proxies
                    must overwrite Cf-Connecting-IP and X-Forwarded-For
  --open            Open the browser

passwd:
  slidecast passwd admin                     Admin password
  slidecast passwd presenter                 Presenter password for every deck
  slidecast passwd presenter --deck <slug>   Presenter password for one deck
  slidecast passwd presenter --deck <slug> --viewer
                                            Viewer password for one deck
  --clear           Remove the password instead of setting one
  --state <dir>     Server state folder (default as for serve)
  The password is read twice from the terminal, or one line from stdin.
`;

function fail(message) {
  process.stderr.write(`slidecast: ${message}\n`);
  process.exitCode = 1;
}

// ---- state folder ----------------------------------------------------------

function userStateDir() {
  const base = process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? process.env.APPDATA : null)
    || join(homedir(), '.config');
  return join(base, 'slidecast');
}

// ./.slidecast, unless that puts the state (signing secret, password hashes)
// inside the deck being served, as `cd my-deck && slidecast serve .` would:
// then the user's config folder, moving an existing ./.slidecast there.
async function defaultStateDir(deckDir) {
  const local = resolve('.slidecast');
  if (!deckDir || !local.startsWith(deckDir + sep)) return './.slidecast';
  const user = userStateDir();
  if (existsSync(local) && !existsSync(user)) {
    await mkdir(dirname(user), { recursive: true });
    await cp(local, user, { recursive: true });
    await rm(local, { recursive: true });
    process.stderr.write(`slidecast: moved the state folder out of the deck, to ${user}\n`);
  }
  return user;
}

// ---- serve -----------------------------------------------------------------

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

async function serve(argv) {
  const env = process.env;
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: 'string', default: env.SLIDECAST_DATA ?? './decks' },
      state: { type: 'string', default: env.SLIDECAST_STATE },
      host: { type: 'string', default: env.SLIDECAST_HOST ?? '127.0.0.1' },
      port: { type: 'string', default: env.SLIDECAST_PORT ?? '4321' },
      'trust-proxy': { type: 'boolean', default: env.SLIDECAST_TRUST_PROXY === '1' },
      open: { type: 'boolean', default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return fail(`invalid port: ${values.port}`);

  let dataDir = values.data;
  let singleDeck = null;
  if (positionals[0]) {
    const p = resolve(positionals[0]);
    if (!existsSync(p) || !statSync(p).isDirectory()) return fail(`not a folder: ${positionals[0]}`);
    if (existsSync(join(p, 'index.html'))) singleDeck = p;
    else dataDir = p;
  }
  values.state ??= await defaultStateDir(singleDeck);

  const app = await buildServer({
    dataDir,
    stateDir: values.state,
    singleDeck,
    trustProxy: values['trust-proxy'],
    logger: { level: env.SLIDECAST_LOG ?? 'warn' },
  });
  await app.listen({ host: values.host, port });
  const actual = app.server.address().port;
  const config = app.slidecast.config;
  const path = singleDeck ? `/${slugFromFolder(singleDeck)}` : '/';
  const shown = LOOPBACK_HOSTS.has(values.host) || values.host === '0.0.0.0' ? '127.0.0.1' : values.host;
  const lines = [`slidecast ${VERSION}`];
  if (singleDeck) lines.push(`Single deck: ${singleDeck}`);
  else lines.push(`Decks: ${resolve(dataDir)}`);
  lines.push(`Open:  http://${shown.includes(':') ? `[${shown}]` : shown}:${actual}${path}`);
  if (values.host === '0.0.0.0') {
    for (const ip of lanAddresses()) lines.push(`       http://${ip}:${actual}${path}`);
  }
  lines.push(`Admin: http://${shown.includes(':') ? `[${shown}]` : shown}:${actual}/admin`);
  if (!LOOPBACK_HOSTS.has(values.host)) {
    const missing = [!config.presenterHash && 'presenter', !config.adminHash && 'admin'].filter(Boolean);
    if (missing.length) {
      lines.push('', `Warning: listening on ${values.host} with no ${missing.join(' or ')} password.`,
        'Other devices cannot present or administer until you set one:',
        ...missing.map((k) => `  slidecast passwd ${k}${values.state !== './.slidecast' ? ` --state ${values.state}` : ''}`));
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (values.open) openBrowser(`http://127.0.0.1:${actual}${path}`);

  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return undefined;
}

// ---- passwd ----------------------------------------------------------------

// Reads a line from the terminal without echoing it.
function readHidden(prompt) {
  return new Promise((resolveLine, reject) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    let line = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolveLine(line);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
    };
    function done() {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    }
    stdin.on('data', onData);
  });
}

async function readStdinLine() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

async function passwd(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      deck: { type: 'string' },
      viewer: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      state: { type: 'string', default: process.env.SLIDECAST_STATE },
    },
  });
  // Run from inside a deck folder, use the same state folder `serve .` would.
  values.state ??= await defaultStateDir(existsSync('index.html') ? resolve('.') : null);
  const which = positionals[0];
  let kind;
  if (which === 'admin' && !values.deck && !values.viewer) kind = 'admin';
  else if ((which === 'presenter' || which === 'viewer') && values.deck) {
    kind = values.viewer || which === 'viewer' ? 'deckViewer' : 'deckPresenter';
  } else if (which === 'presenter' && !values.viewer) kind = 'presenter';
  else return fail('usage: slidecast passwd admin | presenter [--deck <slug> [--viewer]] [--clear]');
  if (values.deck && !isValidSlug(values.deck)) return fail(`invalid deck name: ${values.deck}`);

  let hash = null;
  if (!values.clear) {
    let password;
    if (process.stdin.isTTY) {
      password = await readHidden('New password: ');
      const again = await readHidden('Repeat it: ');
      if (password !== again) return fail('the passwords do not match');
    } else {
      password = await readStdinLine();
    }
    const problem = checkPasswordInput(password);
    const messages = {
      'password-too-short': 'the password needs 8 characters or more',
      'password-too-weak': 'the password needs at least one letter and one digit',
      'password-too-long': 'the password is too long',
    };
    if (problem) return fail(messages[problem]);
    hash = await hashPassword(password);
  }

  const config = await loadConfig(values.state);
  applyPasswordHash(config, kind, values.deck ?? null, hash);
  await saveConfig(values.state, config);
  // Revoke sessions here too, in case the server is not running (a running
  // server notices the config change and revokes them itself).
  const sessionsPath = join(values.state, 'sessions.json');
  const sessions = await readJson(sessionsPath, null).catch(() => null);
  if (sessions) {
    revokeScope(sessions, config, kind, values.deck);
    await writeJsonAtomic(sessionsPath, sessions);
  }
  const what = { admin: 'Admin', presenter: 'Presenter', deckPresenter: `Presenter (${values.deck})`, deckViewer: `Viewer (${values.deck})` }[kind];
  process.stdout.write(`${what} password ${values.clear ? 'removed' : 'set'}.\n`);
  return undefined;
}

// ---- new -------------------------------------------------------------------

async function newDeck(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { data: { type: 'string', default: process.env.SLIDECAST_DATA ?? './decks' } },
  });
  const slug = positionals[0];
  if (!isValidSlug(slug)) return fail(`invalid deck name: ${slug ?? '(none)'} (use a-z, 0-9 and -)`);
  const target = join(values.data, slug);
  if (existsSync(target)) return fail(`${target} already exists`);
  await cp(join(EXAMPLES_DIR, 'demo'), target, { recursive: true });
  const metaPath = join(target, 'deck.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.title = slug;
  await writeJsonAtomic(metaPath, meta);
  process.stdout.write(`Created ${target}/index.html — edit it, then: slidecast serve ${values.data}\n`);
  return undefined;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return process.stdout.write(HELP);
    if (cmd === '--version' || cmd === '-v') return process.stdout.write(`${VERSION}\n`);
    if (cmd === 'serve') return await serve(rest);
    if (cmd === 'passwd') return await passwd(rest);
    if (cmd === 'new') return await newDeck(rest);
    return fail(`unknown command: ${cmd} (see slidecast --help)`);
  } catch (err) {
    return fail(err.message);
  }
}

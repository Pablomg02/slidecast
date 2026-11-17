import { mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readJson, writeJsonAtomic } from './store.js';
import { defaultAppearance } from './appearance.js';

export function defaultConfig() {
  return {
    version: 1,
    secret: randomBytes(32).toString('base64url'),
    adminHash: null,
    presenterHash: null,
    publicListing: true,
    appearance: defaultAppearance(),
    decks: {},
    rooms: {},
  };
}

export async function loadConfig(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700).catch(() => {});
  const path = join(stateDir, 'config.json');
  const stored = await readJson(path, null);
  if (stored) {
    return {
      ...defaultConfig(),
      ...stored,
      appearance: { ...defaultAppearance(), ...stored.appearance },
      decks: stored.decks ?? {},
      rooms: stored.rooms ?? {},
    };
  }
  const config = defaultConfig();
  await writeConfigFile(path, config);
  return config;
}

export function saveConfig(stateDir, config) {
  return writeConfigFile(join(stateDir, 'config.json'), config);
}

// Every write stamps config.json with a new random `writeId`. A running server
// polls the file for changes made by `slidecast passwd`, and the poll sees its
// own writes too, maybe an older one read after a newer change in memory: the
// ids it wrote lately tell them apart (by content they cannot: a password
// cleared with the CLI may give back a file the server wrote before).
const OWN_WRITES_KEPT = 20;
const ownWrites = new Map(); // resolved path → write ids, oldest first

function writeConfigFile(path, config) {
  const writeId = randomBytes(12).toString('base64url');
  const key = resolve(path);
  const ids = ownWrites.get(key) ?? [];
  ids.push(writeId);
  if (ids.length > OWN_WRITES_KEPT) ids.shift();
  ownWrites.set(key, ids);
  // Serialised when its turn to write comes, as `config` is then.
  return writeJsonAtomic(path, { toJSON: () => ({ ...config, writeId }) });
}

// Whether this process wrote `fresh`, a config.json just read from `path`.
export function isOwnConfigWrite(path, fresh) {
  return Boolean(fresh?.writeId) && (ownWrites.get(resolve(path))?.includes(fresh.writeId) ?? false);
}

// Per-deck password hashes, or an empty entry.
export function deckAuth(config, slug) {
  return config.decks[slug] ?? { presenterHash: null, viewerHash: null };
}

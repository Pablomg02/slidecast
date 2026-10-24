import { mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
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
  await writeJsonAtomic(path, config);
  return config;
}

export function saveConfig(stateDir, config) {
  return writeJsonAtomic(join(stateDir, 'config.json'), config);
}

// Per-deck password hashes, or an empty entry.
export function deckAuth(config, slug) {
  return config.decks[slug] ?? { presenterHash: null, viewerHash: null };
}

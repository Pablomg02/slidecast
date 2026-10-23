import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(here, '..');
export const PUBLIC_DIR = join(ROOT_DIR, 'public');
export const EXAMPLES_DIR = join(ROOT_DIR, 'examples');

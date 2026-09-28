// Loader for the compiled output in dist/.
//
// These scripts are plain .mjs, so they import the BUILT javascript rather than
// src/*.ts — run `npm run build` first. Paths resolve relative to this file, not
// the working directory or a hardcoded absolute path, so the scripts keep
// working when the repo is renamed, moved, or cloned somewhere else.
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Import one module from dist/, e.g. load('email/gmail.js').
 * Fails with a build hint rather than a bare ERR_MODULE_NOT_FOUND.
 */
export async function load(modulePath) {
  const full = join(DIST, modulePath);
  if (!existsSync(full)) {
    console.error(
      `Cannot find ${modulePath} in dist/.\n` +
        (existsSync(DIST)
          ? 'The build looks stale — re-run:  npm run build'
          : 'The project has not been built yet — run:  npm run build')
    );
    process.exit(1);
  }
  return import(pathToFileURL(full).href);
}

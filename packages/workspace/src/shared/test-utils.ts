/**
 * Test-only helpers that contain `EpicenterRoot` brand casts in one place.
 *
 * Production code mints `EpicenterRoot` via `findEpicenterRoot`, which validates
 * that the path contains `epicenter.config.ts`. Tests use `mkdtempSync` for
 * fresh tmpdirs and do not always invoke `findEpicenterRoot`, so they need an
 * explicit cast. Owning the cast here
 * keeps the brand contract honest at the call site (the cast lives in a
 * function whose name spells out "test").
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EpicenterRoot } from './types.js';

/**
 * Create a fresh tmp directory and return it as `EpicenterRoot`. The cast
 * is honest in spirit (tests set up the config marker they need) and
 * contained to this helper.
 *
 * @example
 * ```ts
 * let workdir: EpicenterRoot;
 * beforeEach(() => { workdir = mintTestEpicenterRoot('fuji-integration-'); });
 * ```
 */
export function mintTestEpicenterRoot(prefix: string): EpicenterRoot {
	return mkdtempSync(join(tmpdir(), prefix)) as EpicenterRoot;
}

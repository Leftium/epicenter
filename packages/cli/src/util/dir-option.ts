/**
 * Shared `--dir` / `-C` flag for commands that load an `epicenter.config.ts`.
 *
 * Mirrors the convention used by `git -C`, `cargo --manifest-path`,
 * `pnpm --dir`, and `bun --cwd` — point the command at a directory other
 * than the current working directory without shell gymnastics.
 */

import type { Options } from 'yargs';

/** Yargs option spec for `--dir` (alias `-C`). */
export const dirOption: Options = {
	type: 'string',
	alias: 'C',
	default: '.',
	description: 'Directory containing epicenter.config.ts',
};

/** Read `--dir` from parsed argv, defaulting to the current directory. */
export function dirFromArgv(argv: Record<string, unknown>): string {
	return typeof argv.dir === 'string' ? argv.dir : '.';
}

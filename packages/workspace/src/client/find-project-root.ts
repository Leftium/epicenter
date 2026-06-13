import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_CONFIG_FILENAME } from '../config/project-config-source.js';
import type { ProjectDir } from '../shared/types.js';

export function findProjectRoot(start: string = process.cwd()): ProjectDir {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, PROJECT_CONFIG_FILENAME))) {
			return current as ProjectDir;
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(
				`findProjectRoot: no ${PROJECT_CONFIG_FILENAME} found walking up from ${start}. ` +
					`Discovery is upward-only and never scans down, so run from inside an ` +
					`Epicenter namespace root (the folder containing ${PROJECT_CONFIG_FILENAME}), ` +
					`pass \`-C <namespace-root>\`, or run \`epicenter init\` to create one.`,
			);
		}
		current = parent;
	}
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EPICENTER_CONFIG_FILENAME } from '../config/epicenter-config-source.js';
import type { EpicenterRoot } from '../shared/types.js';

export function findEpicenterRoot(
	start: string = process.cwd(),
): EpicenterRoot {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, EPICENTER_CONFIG_FILENAME))) {
			return current as EpicenterRoot;
		}

		const parent = dirname(current);
		if (parent === current) {
			throw new Error(
				`No ${EPICENTER_CONFIG_FILENAME} found walking up from ${start}. ` +
					`Discovery is upward-only and never scans down, so run from inside your ` +
					`Epicenter folder (the folder that holds ${EPICENTER_CONFIG_FILENAME}), ` +
					`pass \`-C <epicenter-root>\`, or run \`epicenter init\` to create one.`,
			);
		}
		current = parent;
	}
}

/**
 * Shared namespace-root option for commands that address a local daemon.
 *
 * By default commands discover the nearest Epicenter namespace root (the folder
 * containing `epicenter.config.ts`) from the current working directory.
 * `-C <dir>` changes the discovery start point.
 */

import { findEpicenterRoot } from '@epicenter/workspace/node';
import type { Options } from 'yargs';

export const projectOption = {
	type: 'string',
	description:
		'Epicenter namespace root (or any directory under it; discovery walks up to the nearest `epicenter.config.ts`).',
	default: () => process.cwd(),
	defaultDescription: 'current working directory',
	coerce: findEpicenterRoot,
} satisfies Options;

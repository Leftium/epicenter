/**
 * `epicenter init [dir]`: scaffold a new Epicenter folder.
 *
 * Writes the default `epicenter.config.ts` into the target directory (the
 * literal directory given; no discovery, because init creates the Epicenter
 * root). That directory becomes your Epicenter folder: Epicenter owns its
 * direct children (the `.epicenter/` machine state and the generated mount
 * projections), so point init at a dedicated folder such as `epicenter/` or
 * `apps/`, not at a repo root that already holds source. The folder name is
 * your choice; nothing reserves the name `apps`. Idempotent: an existing config
 * is left untouched.
 *
 * Creating an Epicenter folder is an explicit user decision; `epicenter daemon
 * up` never scaffolds and instead points here when the config is missing.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PROJECT_CONFIG_SOURCE } from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';

export const initCommand = cmd({
	command: 'init [dir]',
	describe: 'Scaffold epicenter.config.ts in a directory.',
	builder: (yargs) =>
		yargs.positional('dir', {
			type: 'string',
			default: () => process.cwd(),
			defaultDescription: 'current working directory',
			describe: 'Directory to become the Epicenter root',
			coerce: (dir: string) => resolve(dir),
		}),
	handler: (argv) => {
		const projectConfigPath = join(argv.dir, 'epicenter.config.ts');
		if (existsSync(projectConfigPath)) {
			process.stderr.write(`${projectConfigPath} already exists; left as is\n`);
			return;
		}
		writeFileSync(projectConfigPath, DEFAULT_PROJECT_CONFIG_SOURCE, {
			mode: 0o600,
		});
		process.stdout.write(`created ${projectConfigPath}\n`);
	},
});

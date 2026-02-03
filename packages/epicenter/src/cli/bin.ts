#!/usr/bin/env bun

import { resolve } from 'node:path';
import { tryAsync } from 'wellcrafted/result';
import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';
import { findConfigsInSubdirs, findProjectDir, loadClient } from './discovery';

/**
 * Parse -C/--dir flag from argv BEFORE yargs processes subcommands.
 * Returns the base directory and remaining args.
 */
function parseDirectoryFlag(argv: string[]): { baseDir: string; remainingArgs: string[] } {
	const args = [...argv];
	let baseDir = process.cwd();

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;

		// Handle -C <dir> or --dir <dir>
		if (arg === '-C' || arg === '--dir') {
			const nextArg = args[i + 1];
			if (!nextArg || nextArg.startsWith('-')) {
				console.error(`Error: ${arg} requires a directory argument`);
				process.exit(1);
			}
			baseDir = resolve(nextArg);
			args.splice(i, 2);
			i--; // Adjust index after removal
			continue;
		}

		// Handle -C=<dir> or --dir=<dir>
		if (arg.startsWith('-C=')) {
			baseDir = resolve(arg.slice(3));
			args.splice(i, 1);
			i--;
			continue;
		}
		if (arg.startsWith('--dir=')) {
			baseDir = resolve(arg.slice(6));
			args.splice(i, 1);
			i--;
			continue;
		}
	}

	return { baseDir, remainingArgs: args };
}

async function main() {
	await tryAsync({
		try: async () => {
			await enableWatchMode();

			// Parse -C/--dir before anything else
			const { baseDir, remainingArgs } = parseDirectoryFlag(hideBin(process.argv));

			// Try to find config in the specified directory
			const projectDir = await findProjectDir(baseDir);

			if (!projectDir) {
				// No config in CWD/specified dir - check for ambiguity in subdirs
				const subdirConfigs = await findConfigsInSubdirs(baseDir);

				if (subdirConfigs.length > 0) {
					// Ambiguous: multiple configs in subdirectories
					console.error('No epicenter.config.ts found in current directory.');
					console.error('');
					console.error('Found configs in subdirectories:');
					for (const config of subdirConfigs) {
						console.error(`  - ${config}`);
					}
					console.error('');
					console.error('Use -C <dir> to specify which project:');
					const exampleDir = subdirConfigs[0]!.replace('/epicenter.config.ts', '');
					console.error(`  epicenter -C ${exampleDir} <command>`);
					process.exit(1);
				}

				// No configs found anywhere
				console.error('No epicenter.config.ts found.');
				console.error(
					'Create one with named exports: export const myClient = createWorkspaceClient({...})',
				);
				process.exit(1);
			}

			const client = await loadClient(projectDir);
			await createCLI(client).run(remainingArgs);
		},
		catch: (error) => {
			if (error instanceof Error) {
				console.error('Error:', error.message);
			} else {
				console.error('Unknown error:', error);
			}
			process.exit(1);
		},
	});
}

async function enableWatchMode() {
	if (process.env.EPICENTER_WATCH_MODE) {
		return;
	}

	const scriptPath = process.argv[1];
	if (!scriptPath) {
		throw new Error(
			'Internal error: Failed to start epicenter (missing script path)',
		);
	}

	const proc = Bun.spawn(
		['bun', '--watch', scriptPath, ...process.argv.slice(2)],
		{
			env: {
				...process.env,
				EPICENTER_WATCH_MODE: '1',
			},
			stdio: ['inherit', 'inherit', 'inherit'],
		},
	);

	await proc.exited;
	process.exit(proc.exitCode ?? 0);
}

main();

#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';
import { resolveWorkspace } from './discovery';

/**
 * Parse -C/--dir flag from argv BEFORE yargs processes subcommands.
 * Returns the base directory and remaining args.
 */
function parseDirectoryFlag(argv: string[]): {
	baseDir: string;
	remainingArgs: string[];
} {
	let baseDir = process.cwd();
	const remainingArgs: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;

		// Handle -C <dir> or --dir <dir>
		if (arg === '-C' || arg === '--dir') {
			const nextArg = argv[i + 1];
			if (!nextArg || nextArg.startsWith('-')) {
				console.error(`Error: ${arg} requires a directory argument`);
				process.exit(1);
			}
			baseDir = resolve(nextArg);
			i++; // Skip next arg
			continue;
		}

		// Handle -C=<dir> or --dir=<dir>
		if (arg.startsWith('-C=')) {
			baseDir = resolve(arg.slice(3));
			continue;
		}
		if (arg.startsWith('--dir=')) {
			baseDir = resolve(arg.slice(6));
			continue;
		}

		remainingArgs.push(arg);
	}

	return { baseDir, remainingArgs };
}

async function main() {
	try {
		await enableWatchMode();

		const { baseDir, remainingArgs } = parseDirectoryFlag(
			hideBin(process.argv),
		);

		const result = await resolveWorkspace(baseDir);

		if (result.status === 'not_found') {
			console.error('No epicenter.config.ts found.');
			console.error(
				'Create one: export const workspace = createWorkspaceClient({...})',
			);
			process.exit(1);
		}

		if (result.status === 'ambiguous') {
			console.error('No epicenter.config.ts found in current directory.');
			console.error('');
			console.error('Found configs in subdirectories:');
			for (const config of result.configs) {
				console.error(`  - ${config}`);
			}
			console.error('');
			console.error('Use -C <dir> to specify which project:');
			console.error(`  epicenter -C ${dirname(result.configs[0]!)} <command>`);
			process.exit(1);
		}

		// result.status === 'found'
		await createCLI(result.client).run(remainingArgs);
	} catch (error) {
		if (error instanceof Error) {
			console.error('Error:', error.message);
		} else {
			console.error('Unknown error:', error);
		}
		process.exit(1);
	}
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

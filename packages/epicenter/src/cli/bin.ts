#!/usr/bin/env bun

import { Ok, tryAsync } from 'wellcrafted/result';
import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';
import { findProjectDir, loadClients } from './discovery';

async function main() {
	await tryAsync({
		try: async () => {
			await enableWatchMode();

			const projectDir = await findProjectDir();
			if (!projectDir) {
				console.error('No epicenter.config.ts found.');
				console.error('Create one that exports an array of workspace clients.');
				process.exit(1);
			}

			const clients = await loadClients(projectDir);
			await createCLI(clients).run(hideBin(process.argv));
		},
		catch: (error) => {
			if (error instanceof Error) {
				console.error('Error:', error.message);
			} else {
				console.error('Unknown error:', error);
			}
			process.exit(1);
			return Ok(undefined);
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

#!/usr/bin/env bun

import { Err, tryAsync } from 'wellcrafted/result';
import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli';
import { EXIT } from './util/exit-codes';

async function main() {
	const result = await tryAsync({
		try: () => createCLI().run(hideBin(process.argv)),
		catch: (error) => Err(String(error)),
	});

	if (result.error) {
		console.error('Error:', result.error);
		process.exit(EXIT.USAGE);
	}
}

main();

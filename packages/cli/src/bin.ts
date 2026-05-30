#!/usr/bin/env bun

import { hideBin } from 'yargs/helpers';
import { createCLI } from './cli.js';

try {
	await createCLI().run(hideBin(process.argv));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`error: ${message}`);
	process.exit(1); // top-level failure: usage error or uncaught throw (see README: Exit codes)
}

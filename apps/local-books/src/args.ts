import type { QbEnvironment } from './tokens.ts';

/** Parsed command-line arguments shared by the command handlers. */
export type ParsedArgs = {
	command: string;
	full: boolean;
	entities: string[];
	dataDir?: string;
	realm?: string;
	environment?: QbEnvironment;
	help: boolean;
	version: boolean;
};

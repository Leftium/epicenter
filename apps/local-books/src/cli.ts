import { runAuth } from './commands/auth.ts';
import { runStatus } from './commands/status.ts';
import { runSync } from './commands/sync.ts';
import type { QbEnvironment } from './config.ts';

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

export const VERSION = '0.0.1';

const HELP = `local-books — mirror a QuickBooks Online company into local SQLite

Usage:
  local-books auth [options]
  local-books sync [--full] [--entity <name>]... [options]
  local-books status [options]

Commands:
  auth      One-time OAuth2 against QuickBooks (localhost callback). Tokens -> OS keyring.
  sync      Refresh the mirror. Mode (FULL / INCREMENTAL) is chosen from stored state.
  status    Show token state and the per-entity cursor, row counts, and last full pull.

Options:
  --full                       Force a full pull (sync only).
  --entity <name>              Limit sync to these entities (repeatable). Default: all configured.
  --realm <realmId>            Target company (default: the authenticated one).
  --data-dir <path>            Override the data directory (or LOCAL_BOOKS_DIR).
  --env <sandbox|production>   QuickBooks environment (default: sandbox).
  -h, --help                   Show this help.
  -v, --version                Show version.

Environment:
  LOCAL_BOOKS_QB_CLIENT_ID / _SECRET   Intuit app credentials (required for auth).
  LOCAL_BOOKS_DIR                       Data directory.
  LOCAL_BOOKS_KEYRING_FILE              Plaintext file token store instead of the OS keyring.
`;

export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: '',
		full: false,
		entities: [],
		help: false,
		version: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;

		if (!token.startsWith('-')) {
			if (!args.command) args.command = token;
			else throw new Error(`Unexpected argument: ${token}`);
			continue;
		}

		const eq = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = eq === -1 ? token : token.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

		const takeValue = (): string => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[i + 1];
			if (next === undefined) throw new Error(`Option ${name} needs a value`);
			i += 1;
			return next;
		};

		switch (name) {
			case '--full':
				args.full = true;
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
			case '-v':
			case '--version':
				args.version = true;
				break;
			case '--entity':
				args.entities.push(takeValue());
				break;
			case '--realm':
				args.realm = takeValue();
				break;
			case '--data-dir':
				args.dataDir = takeValue();
				break;
			case '--env':
			case '--environment': {
				const value = takeValue();
				if (value !== 'sandbox' && value !== 'production') {
					throw new Error(
						`--env must be "sandbox" or "production", got "${value}"`,
					);
				}
				args.environment = value as QbEnvironment;
				break;
			}
			default:
				throw new Error(`Unknown option: ${name}`);
		}
	}

	return args;
}

export async function runCli(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.version) {
		console.log(VERSION);
		return 0;
	}
	if (args.help || !args.command) {
		console.log(HELP);
		return args.help ? 0 : 1;
	}

	switch (args.command) {
		case 'auth':
			return runAuth(args);
		case 'sync':
			return runSync(args);
		case 'status':
			return runStatus(args);
		default:
			console.error(`Unknown command: ${args.command}\n`);
			console.log(HELP);
			return 1;
	}
}

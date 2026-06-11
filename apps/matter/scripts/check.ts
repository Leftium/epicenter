import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildCheckResult,
	buildFatalCheckReport,
	isFatalCheckReport,
	type CheckResult,
} from '../src/lib/core/check-report';
import { formatCheckResult } from '../src/lib/core/check-format';
import {
	MatterReadError,
	readFolder,
	type FolderEntry,
} from '../src/lib/core/folder';

type Args =
	| { json: boolean; folder: string }
	| { json: boolean; error: string };

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, '..');
const repoRoot = resolve(appRoot, '../..');

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv: string[]): Args {
	let json = false;
	let folder: string | undefined;

	for (const arg of argv) {
		if (arg === '--json') {
			json = true;
			continue;
		}

		if (arg.startsWith('-')) {
			return { json, error: `unknown option ${arg}` };
		}

		if (folder !== undefined) {
			return { json, error: `expected one folder, got ${folder} and ${arg}` };
		}
		folder = arg;
	}

	return { json, folder: folder ?? '.' };
}

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch(() => false);
}

async function resolveFolder(folder: string): Promise<string> {
	const direct = resolve(folder);
	if (await exists(direct)) return direct;

	const appPrefixed = `apps${sep}matter${sep}`;
	if (folder === `apps${sep}matter` || folder.startsWith(appPrefixed)) {
		return resolve(repoRoot, folder);
	}

	return direct;
}

async function readModelText(
	folder: string,
	displayFolder: string,
): Promise<
	{ kind: 'loaded'; text: string } | { kind: 'missing' } | { fatal: CheckResult }
> {
	try {
		return {
			kind: 'loaded',
			text: await readFile(join(folder, 'matter.json'), 'utf8'),
		};
	} catch (error) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			error.code === 'ENOENT'
		) {
			return { kind: 'missing' };
		}

		return {
			fatal: buildFatalCheckReport(
				displayFolder,
				'MODEL_INVALID',
				`matter.json could not be read: ${messageOf(error)}`,
			),
		};
	}
}

async function readEntries(
	folder: string,
	displayFolder: string,
): Promise<FolderEntry[] | CheckResult> {
	let names: string[];
	try {
		names = (await readdir(folder))
			.filter((name) => name.endsWith('.md'))
			.sort();
	} catch (error) {
		return buildFatalCheckReport(
			displayFolder,
			'FOLDER_UNREADABLE',
			`folder could not be read: ${messageOf(error)}`,
		);
	}

	return Promise.all(
		names.map(async (fileName): Promise<FolderEntry> => {
			try {
				return {
					fileName,
					content: await readFile(join(folder, fileName), 'utf8'),
				};
			} catch (cause) {
				return {
					fileName,
					error: MatterReadError.ReadFailed({ cause }).error,
				};
			}
		}),
	);
}

function writeResult(report: CheckResult, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	const text = `${formatCheckResult(report)}\n`;
	if (isFatalCheckReport(report)) {
		process.stderr.write(text);
	} else {
		process.stdout.write(text);
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if ('error' in args) {
		process.stderr.write(`${args.error}\n`);
		return 2;
	}

	const folder = await resolveFolder(args.folder);
	const entries = await readEntries(folder, args.folder);
	if (!Array.isArray(entries)) {
		writeResult(entries, args.json);
		return 2;
	}

	const modelText = await readModelText(folder, args.folder);
	if ('fatal' in modelText) {
		writeResult(modelText.fatal, args.json);
		return 2;
	}
	if (modelText.kind === 'missing') {
		writeResult(
			buildFatalCheckReport(
				args.folder,
				'MODEL_MISSING',
				'matter.json is missing',
			),
			args.json,
		);
		return 2;
	}

	const report = buildCheckResult(args.folder, readFolder(entries, modelText.text));
	writeResult(report, args.json);
	if (isFatalCheckReport(report)) return 2;
	return report.summary.needsAttention === 0 && report.summary.unreadable === 0
		? 0
		: 1;
}

process.exitCode = await main();

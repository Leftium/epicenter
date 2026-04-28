import type { Result } from 'wellcrafted/result';

export type FormatOptions = {
	/** Override format (default: json, auto-pretty for TTY) */
	format?: 'json' | 'jsonl';
};

/** Format a single value as JSON: pretty on TTY unless `format: 'jsonl'`. */
function formatJson(value: unknown, options: FormatOptions = {}): string {
	const shouldPretty =
		options.format !== 'jsonl' && (process.stdout.isTTY ?? false);
	return JSON.stringify(value, null, shouldPretty ? 2 : undefined);
}

/** Format an array as JSONL: one JSON value per line. */
function formatJsonl(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}

/** Output data to stdout with appropriate formatting. */
export function output(value: unknown, options: FormatOptions = {}): void {
	if (options.format === 'jsonl') {
		if (!Array.isArray(value)) {
			throw new Error('JSONL format requires an array value');
		}
		console.log(formatJsonl(value));
	} else {
		console.log(formatJson(value, options));
	}
}

/**
 * Output an error message to stderr
 */
export function outputError(message: string): void {
	console.error(message);
}

/**
 * Common end-of-IPC rendering for attached-mode commands. Success flows
 * to `onSuccess`; transport- and handler-level errors collapse to
 * `outputError` + `exitCode=1` here so handlers don't repeat that block
 * three times.
 *
 * Domain errors that callers want to render distinctly should be carried
 * inside the `T` payload (e.g. `ListResult`'s in-band `PeerMiss`), not
 * surfaced as IPC errors. That's why the success callback receives the
 * raw `data` rather than a `Result`.
 */
export async function renderDaemonResult<T>(
	result: Result<T, { message: string }>,
	onSuccess: (data: T) => void | Promise<void>,
): Promise<void> {
	if (result.error === null) {
		await onSuccess(result.data);
		return;
	}
	outputError(`error: ${result.error.message}`);
	process.exitCode = 1;
}

/**
 * Create yargs options for format flag
 */
export function formatYargsOptions() {
	return {
		format: {
			type: 'string' as const,
			choices: ['json', 'jsonl'] as const,
			description: 'Output format (default: json, auto-pretty for TTY)',
		},
	};
}

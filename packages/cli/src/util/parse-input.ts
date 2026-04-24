import { readFileSync } from 'node:fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';

export type ParseInputOptions = {
	/** Positional argument: inline JSON, or `@file.json` (curl convention) */
	positional?: string;
	/** Stdin content (undefined = no piped input) */
	stdinContent?: string;
};

const ParseInputError = defineErrors({
	InvalidJson: ({ cause }: { cause: unknown }) => ({
		message: `Invalid JSON: ${extractErrorMessage(cause)}`,
		cause,
	}),
	FileNotFound: ({ path }: { path: string }) => ({
		message: `File not found: ${path}`,
		path,
	}),
	FileReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Error reading file '${path}': ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
});
type ParseInputError = InferErrors<typeof ParseInputError>;

function parseJson<T>(input: string): Result<T, ParseInputError> {
	return trySync({
		try: () => JSON.parse(input) as T,
		catch: (error) => ParseInputError.InvalidJson({ cause: error }),
	});
}

function readJsonFile<T>(filePath: string): Result<T, ParseInputError> {
	const { data: content, error: readError } = trySync({
		try: () => readFileSync(filePath, 'utf-8'),
		catch: (error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return ParseInputError.FileNotFound({ path: filePath });
			}
			return ParseInputError.FileReadFailed({
				path: filePath,
				cause: error,
			});
		},
	});

	if (readError) return Err(readError);

	return parseJson<T>(content);
}

/**
 * Parse JSON input from various sources.
 * Priority: positional (inline JSON or `@file`) > stdin.
 * Returns `Ok(undefined as T)` when no source is populated.
 */
export function parseJsonInput<T = unknown>(
	options: ParseInputOptions,
): Result<T, ParseInputError> {
	// 1. Positional: inline JSON, or `@file.json` (curl convention).
	if (options.positional) {
		if (options.positional.startsWith('@')) {
			const filePath = options.positional.slice(1);
			return readJsonFile<T>(filePath);
		}
		return parseJson<T>(options.positional);
	}

	// 2. Stdin.
	if (options.stdinContent) {
		return parseJson<T>(options.stdinContent);
	}

	return Ok(undefined as T);
}

/**
 * Read piped stdin content (for CLI use). Returns undefined when stdin
 * is a TTY (interactive terminal — no pipe).
 *
 * Caveat: if stdin reports non-TTY but no writer is connected (pathological
 * CI/Docker TTY-allocation shapes), `Bun.stdin.text()` blocks until the OS
 * closes the fd. This is rare; the fix is environmental (redirect
 * `</dev/null`) rather than adding per-invocation latency for the common
 * healthy-pipe case.
 */
export async function readStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;
	const text = await Bun.stdin.text();
	return text.trim() || undefined;
}

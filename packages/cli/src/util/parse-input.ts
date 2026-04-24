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

const STDIN_FIRST_BYTE_TIMEOUT_MS = 100;

/**
 * Read piped stdin content (for CLI use). Returns undefined when:
 *   - stdin is a TTY (interactive terminal — no pipe)
 *   - no data arrives within `STDIN_FIRST_BYTE_TIMEOUT_MS` (handles the
 *     pathological case where `isTTY` reports false but no writer is
 *     actually connected, e.g. some CI/Docker TTY-allocation shapes —
 *     a naive blocking read hangs forever in that scenario).
 *
 * Once the first byte arrives we read to EOF without a further timeout,
 * so large piped payloads are not truncated.
 */
export async function readStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) return undefined;

	const reader = Bun.stdin.stream().getReader();
	try {
		const firstChunk = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value?: undefined }>((resolve) =>
				setTimeout(
					() => resolve({ done: true }),
					STDIN_FIRST_BYTE_TIMEOUT_MS,
				),
			),
		]);
		if (firstChunk.done || !firstChunk.value) return undefined;

		const chunks: Uint8Array[] = [firstChunk.value];
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) chunks.push(value);
		}

		const total = chunks.reduce((n, c) => n + c.length, 0);
		const buf = new Uint8Array(total);
		let offset = 0;
		for (const c of chunks) {
			buf.set(c, offset);
			offset += c.length;
		}
		return new TextDecoder().decode(buf).trim() || undefined;
	} catch {
		return undefined;
	} finally {
		reader.releaseLock();
	}
}

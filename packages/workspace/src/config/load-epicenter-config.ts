/**
 * Load an Epicenter root's `epicenter.config.ts` and return its mount list.
 *
 * The config default-exports a `Mount[]`. One app is a list of one:
 *
 *   `export default [fuji()];`
 *   `export default [fuji(), notes()];`
 *
 * `epicenter.config.ts` is dynamically imported, so its default export crosses
 * a runtime boundary where TypeScript types are erased and nothing typechecks
 * the user's file first. `isMount` is therefore real input validation, not a
 * stand-in for a nominal type: it asserts the exact two members the daemon
 * consumes (`name: string`, `open: function`) so a malformed config fails with
 * a clear, structured error pointed at the file instead of a cryptic
 * `TypeError` deep in startup.
 *
 * Every failure is an `EpicenterConfigError` variant; this function never throws.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

import type { Mount } from '../daemon/define-mount.js';
import type { EpicenterRoot } from '../shared/types.js';
import { EPICENTER_CONFIG_FILENAME } from './epicenter-config-source.js';

export const EpicenterConfigError = defineErrors({
	EpicenterConfigNotFound: ({
		epicenterConfigPath,
	}: {
		epicenterConfigPath: string;
	}) => ({
		message: `Epicenter config not found at ${epicenterConfigPath}`,
		epicenterConfigPath,
	}),
	EpicenterConfigImportFailed: ({
		epicenterConfigPath,
		cause,
	}: {
		epicenterConfigPath: string;
		cause: unknown;
	}) => ({
		message: `Failed to load Epicenter config at ${epicenterConfigPath}: ${extractErrorMessage(cause)}`,
		epicenterConfigPath,
		cause,
	}),
	EpicenterConfigInvalid: ({
		epicenterConfigPath,
		detail,
	}: {
		epicenterConfigPath: string;
		detail: string;
	}) => ({
		message: `Invalid Epicenter config at ${epicenterConfigPath}: ${detail}.`,
		epicenterConfigPath,
		detail,
	}),
});
export type EpicenterConfigError = InferErrors<typeof EpicenterConfigError>;

export async function loadEpicenterConfig(
	epicenterRoot: EpicenterRoot | string,
): Promise<Result<Mount[], EpicenterConfigError>> {
	const epicenterConfigPath = join(
		resolve(epicenterRoot),
		EPICENTER_CONFIG_FILENAME,
	);
	if (!existsSync(epicenterConfigPath)) {
		return EpicenterConfigError.EpicenterConfigNotFound({ epicenterConfigPath });
	}

	const { data: module, error: importError } = await tryAsync({
		try: () =>
			import(pathToFileURL(epicenterConfigPath).href) as Promise<{
				default?: unknown;
			}>,
		catch: (cause) =>
			EpicenterConfigError.EpicenterConfigImportFailed({
				epicenterConfigPath,
				cause,
			}),
	});
	if (importError !== null) return Err(importError);

	const value = module.default;
	if (Array.isArray(value) && value.every(isMount)) return Ok(value);
	if (isMount(value)) {
		return EpicenterConfigError.EpicenterConfigInvalid({
			epicenterConfigPath,
			detail:
				'the default export is a single Mount; wrap it in an array, for example `export default [fuji()]`',
		});
	}
	return EpicenterConfigError.EpicenterConfigInvalid({
		epicenterConfigPath,
		detail:
			'the default export must be a Mount[] (each entry needs a string `name` and an `open` function)',
	});
}

function isMount(value: unknown): value is Mount {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		typeof (value as { name: unknown }).name === 'string' &&
		'open' in value &&
		typeof (value as { open: unknown }).open === 'function'
	);
}

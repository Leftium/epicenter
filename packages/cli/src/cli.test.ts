/**
 * CLI entry-point tests.
 *
 * Post-redesign surface (see `specs/20260421T155436-cli-scripting-first-redesign.md`):
 *   `auth`, `list`, `run`
 *
 * `list` and `run` land in Phases 3–4. Until then, only `auth` is registered.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { createCLI } from './cli';

describe('createCLI', () => {
	test('returns an object with a run method', () => {
		const cli = createCLI();
		expect(typeof cli.run).toBe('function');
	});

	test('rejects with usage when no arguments provided', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// exitProcess(false) makes yargs throw instead of calling process.exit
		await expect(cli.run([])).rejects.toThrow(
			'Not enough non-option arguments',
		);

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).toContain('epicenter');
		errorSpy.mockRestore();
	});

	test('auth subcommand is registered', async () => {
		const cli = createCLI();
		const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

		// `auth` without a subcommand should fail with yargs' demandCommand message,
		// not an "unknown command" error — proving `auth` itself is registered.
		await expect(cli.run(['auth'])).rejects.toThrow();

		const errorOutput = errorSpy.mock.calls.flat().join(' ');
		expect(errorOutput).not.toContain('Unknown argument');
		errorSpy.mockRestore();
	});
});

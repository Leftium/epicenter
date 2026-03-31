/**
 * Workspace lifecycle helpers for CLI commands.
 *
 * Provides the one-shot open/use/dispose lifecycle (`withWorkspace`),
 * the universal command runner (`runCommand`), shared yargs options,
 * and table resolution.
 */

import type { AnyWorkspaceClient } from '@epicenter/workspace';
import type { Argv, CommandModule } from 'yargs';
import { loadConfig } from '../load-config';
import { formatYargsOptions, output, outputError } from './format-output';

// ─── Types ───────────────────────────────────────────────────────────────────

export type OpenWorkspaceOptions = {
	/** Directory containing epicenter.config.ts. */
	dir: string;
	/** Workspace ID to open (required if config has multiple workspaces). */
	workspaceId?: string;
};

export type OpenWorkspaceResult = {
	/** The workspace client loaded from config. */
	client: AnyWorkspaceClient;
	/** Config directory path. */
	configDir: string;
	/** Gracefully close the workspace (flush persistence). */
	dispose: () => Promise<void>;
};

// ─── Core lifecycle ──────────────────────────────────────────────────────────

/**
 * Open a workspace from disk.
 *
 * Loads the config, finds the requested workspace, waits for ready,
 * and returns the client. Caller is responsible for calling `dispose()`.
 *
 * @example
 * ```typescript
 * const { client, dispose } = await openWorkspaceFromDisk({
 *   dir: '/path/to/project',
 *   workspaceId: 'epicenter.honeycrisp',
 * });
 *
 * const notes = client.tables.notes.getAllValid();
 * await dispose();
 * ```
 */
export async function openWorkspaceFromDisk(
	options: OpenWorkspaceOptions,
): Promise<OpenWorkspaceResult> {
	const { configDir, clients } = await loadConfig(options.dir);

	let client: AnyWorkspaceClient;

	if (options.workspaceId) {
		const found = clients.find((c) => c.id === options.workspaceId);
		if (!found) {
			const ids = clients.map((c) => c.id).join(', ');
			throw new Error(
				`Workspace "${options.workspaceId}" not found. Available: ${ids}`,
			);
		}
		client = found;
	} else if (clients.length === 1) {
		client = clients[0]!;
	} else {
		const ids = clients.map((c) => c.id).join(', ');
		throw new Error(
			`Multiple workspaces found. Specify one with --workspace: ${ids}`,
		);
	}

	await client.whenReady;

	return {
		client,
		configDir,
		dispose: () => client.dispose(),
	};
}

/**
 * Run an operation against a workspace, handling the full open/use/dispose lifecycle.
 *
 * Opens the workspace from disk, passes the client to the callback,
 * then disposes the client (flushes persistence) regardless of success or failure.
 *
 * @example
 * ```typescript
 * const notes = await withWorkspace({ dir: '.' }, (client) => {
 *   return client.tables.notes.getAllValid();
 * });
 * ```
 */
export async function withWorkspace<T>(
	options: OpenWorkspaceOptions,
	fn: (client: AnyWorkspaceClient) => T | Promise<T>,
): Promise<T> {
	const { client, dispose } = await openWorkspaceFromDisk(options);
	try {
		const result = await fn(client);
		return result;
	} finally {
		await dispose();
	}
}

// ─── Command helpers ─────────────────────────────────────────────────────────

/**
 * Add the standard workspace-scoped options to a yargs builder.
 *
 * Every command that operates on a workspace needs `--dir` (project directory),
 * `--workspace` (workspace ID when config exports multiple), and `--format`
 * (output formatting). Call this in your `builder` to avoid duplicating the
 * option definitions across every command file.
 *
 * @example
 * ```typescript
 * builder: (y: Argv) =>
 *   withWorkspaceOptions(y)
 *     .positional('table', { type: 'string', demandOption: true }),
 * ```
 */
export function withWorkspaceOptions<T>(y: Argv<T>) {
	return y
		.option('dir', {
			type: 'string',
			default: '.',
			alias: 'C',
			description: 'Directory containing epicenter.config.ts',
		})
		.option('workspace', {
			type: 'string',
			alias: 'w',
			description: 'Workspace ID (required if config has multiple workspaces)',
		})
		.options(formatYargsOptions());
}

/**
 * Run any workspace command with standard lifecycle and error handling:
 * open workspace → run operation → output result → dispose.
 *
 * This is the universal runner for all one-shot CLI commands. Handles
 * the try/catch/outputError/exitCode boilerplate so command definitions
 * are just a lambda.
 *
 * @example
 * ```typescript
 * await runCommand(
 *   { dir: argv.dir, workspaceId: argv.workspace },
 *   (client) => client.tables.notes.getAllValid(),
 *   argv.format,
 * );
 * ```
 */
export async function runCommand<T>(
	opts: OpenWorkspaceOptions,
	fn: (client: AnyWorkspaceClient) => T | Promise<T>,
	format?: 'json' | 'jsonl',
): Promise<void> {
	try {
		const result = await withWorkspace(opts, fn);
		output(result, { format });
	} catch (err) {
		outputError(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/**
 * Resolve a table by name from a workspace client, or throw a clear error.
 *
 * @example
 * ```typescript
 * const table = resolveTable(client, 'posts');
 * const rows = table.getAllValid();
 * ```
 */
export function resolveTable(client: AnyWorkspaceClient, name: string) {
	const table = client.tables[name];
	if (!table) throw new Error(`Table "${name}" not found`);
	return table;
}

// ─── Command definition ──────────────────────────────────────────────────────

/**
 * Identity function for defining a yargs command with full type inference.
 *
 * Same pattern as `defineConfig` in Vite or `defineStore` in Pinia—a
 * pass-through that narrows the type without any runtime overhead.
 *
 * @example
 * ```typescript
 * export const listCommand = defineCommand({
 *   command: 'list <table>',
 *   describe: 'List all valid rows in a table',
 *   builder: (y) => withWorkspaceOptions(y).positional('table', { type: 'string', demandOption: true }),
 *   handler: async (argv) => { ... },
 * });
 * ```
 */
export function defineCommand(command: CommandModule): CommandModule {
	return command;
}

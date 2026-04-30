/**
 * Workspace config loader.
 *
 * `epicenter.config.ts` is a daemon host manifest. The loader reads the
 * default `defineEpicenterConfig({ hosts })` export, validates host definitions,
 * starts them with project context, and returns the internal `WorkspaceEntry[]`
 * used by the daemon server.
 */

import { dirname, join, resolve } from 'node:path';
import type {
	AbsolutePath,
	PeerAwarenessState,
	ProjectDir,
} from '@epicenter/workspace';
import {
	type DaemonHostDefinition,
	type DaemonWorkspace,
	EPICENTER_CONFIG,
	EPICENTER_DAEMON_HOST,
	type WorkspaceEntry,
} from '@epicenter/workspace/daemon';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

export const CONFIG_FILENAME = 'epicenter.config.ts';

export type { DaemonWorkspace, WorkspaceEntry };

/** Per-peer awareness state under the standard peer schema. */
export type AwarenessState = PeerAwarenessState;

export type LoadConfigResult = {
	entries: WorkspaceEntry[];
	/**
	 * Release every hosted workspace. Host teardown starts by destroying the
	 * Y.Doc, then the loader awaits sync teardown barriers exposed by hosts.
	 */
	[Symbol.asyncDispose](): Promise<void>;
};

const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OBJECT_DANGEROUS_ROUTE_KEYS = new Set([
	'__proto__',
	'prototype',
	'constructor',
]);

export const LoadError = defineErrors({
	MissingFile: ({ configPath }: { configPath: string }) => ({
		message: `No ${CONFIG_FILENAME} found in ${configPath}`,
		configPath,
	}),
	ImportFailed: ({
		configPath,
		cause,
	}: {
		configPath: string;
		cause: unknown;
	}) => ({
		message: `failed to load ${configPath}: ${extractErrorMessage(cause)}`,
		configPath,
		cause,
	}),
	InvalidConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`Invalid ${CONFIG_FILENAME} in ${configPath}: ` +
			`default export must be defineEpicenterConfig({ hosts: [...] }).`,
		configPath,
	}),
	EmptyConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`No daemon hosts found in ${configPath}.\n` +
			`Default-export defineEpicenterConfig({ hosts: [...] }) with at least one host.`,
		configPath,
	}),
	InvalidHostDefinition: ({
		configPath,
		index,
	}: {
		configPath: string;
		index: number;
	}) => ({
		message:
			`Invalid daemon host definition ${index} in ${configPath}: ` +
			`expected route and start().`,
		configPath,
		index,
	}),
	HostFailed: ({
		configPath,
		index,
		cause,
	}: {
		configPath: string;
		index: number;
		cause: unknown;
	}) => ({
		message:
			`Failed to initialize daemon host ${index} in ${configPath}: ` +
			extractErrorMessage(cause),
		configPath,
		index,
		cause,
	}),
	InvalidHost: ({
		configPath,
		index,
	}: {
		configPath: string;
		index: number;
	}) => ({
		message:
			`Invalid daemon host ${index} in ${configPath}: ` +
			`expected actions and [Symbol.dispose].`,
		configPath,
		index,
	}),
	InvalidRoute: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`use letters, numbers, "_" or "-", and do not start with punctuation.`,
		configPath,
		route,
	}),
	DuplicateRoute: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message: `Duplicate daemon route "${route}" in ${configPath}.`,
		configPath,
		route,
	}),
});
export type LoadError = InferErrors<typeof LoadError>;

type ImportedEpicenterConfig = {
	readonly hosts: readonly unknown[];
};

function isEpicenterConfig(value: unknown): value is ImportedEpicenterConfig {
	return (
		value != null &&
		typeof value === 'object' &&
		(value as Record<PropertyKey, unknown>)[EPICENTER_CONFIG] === true &&
		Array.isArray((value as { hosts?: unknown }).hosts)
	);
}

function isDaemonHostDefinition(value: unknown): value is DaemonHostDefinition {
	if (value == null || typeof value !== 'object') return false;
	const record = value as Record<PropertyKey, unknown>;
	return (
		record[EPICENTER_DAEMON_HOST] === true &&
		typeof record.route === 'string' &&
		typeof record.start === 'function'
	);
}

function isDaemonWorkspace(value: unknown): value is DaemonWorkspace {
	if (value == null || typeof value !== 'object') return false;
	const record = value as Record<PropertyKey, unknown>;
	return (
		typeof record.actions === 'object' &&
		record.actions !== null &&
		!Array.isArray(record.actions) &&
		typeof record[Symbol.dispose] === 'function'
	);
}

function isValidRoute(route: string): boolean {
	return ROUTE_PATTERN.test(route) && !OBJECT_DANGEROUS_ROUTE_KEYS.has(route);
}

async function disposeHosts(hosts: DaemonWorkspace[]): Promise<void> {
	const barriers: Promise<unknown>[] = [];
	for (const host of hosts) {
		if (host.sync?.whenDisposed) barriers.push(host.sync.whenDisposed);
		host[Symbol.dispose]();
	}
	await Promise.all(barriers);
}

/**
 * Load daemon hosts from the explicit default daemon host manifest.
 */
export async function loadConfig(
	targetDir: string,
): Promise<Result<LoadConfigResult, LoadError>> {
	const projectDir = resolve(targetDir) as ProjectDir;
	const configPath = join(projectDir, CONFIG_FILENAME);
	const configDir = dirname(configPath) as AbsolutePath;

	if (!(await Bun.file(configPath).exists())) {
		return LoadError.MissingFile({ configPath });
	}

	const importResult = await tryAsync({
		try: () => import(Bun.pathToFileURL(configPath).href),
		catch: (cause) => LoadError.ImportFailed({ configPath, cause }),
	});
	if (importResult.error) return importResult;

	const config = (importResult.data as { default?: unknown }).default;
	if (!isEpicenterConfig(config))
		return LoadError.InvalidConfig({ configPath });
	if (config.hosts.length === 0) return LoadError.EmptyConfig({ configPath });

	const definitions: DaemonHostDefinition[] = [];
	const routes = new Set<string>();
	for (const [index, definition] of config.hosts.entries()) {
		if (!isDaemonHostDefinition(definition)) {
			return LoadError.InvalidHostDefinition({ configPath, index });
		}
		if (!isValidRoute(definition.route)) {
			return LoadError.InvalidRoute({ configPath, route: definition.route });
		}
		if (routes.has(definition.route)) {
			return LoadError.DuplicateRoute({ configPath, route: definition.route });
		}
		routes.add(definition.route);
		definitions.push(definition);
	}

	const entries: WorkspaceEntry[] = [];

	for (const [index, definition] of definitions.entries()) {
		let workspace: unknown;
		try {
			workspace = await definition.start({ projectDir, configDir });
		} catch (cause) {
			await disposeHosts(entries.map((entry) => entry.workspace));
			return LoadError.HostFailed({ configPath, index, cause });
		}

		if (!isDaemonWorkspace(workspace)) {
			await disposeHosts(entries.map((entry) => entry.workspace));
			return LoadError.InvalidHost({ configPath, index });
		}

		entries.push({
			route: definition.route,
			workspace,
		});
	}

	return Ok({
		entries,
		[Symbol.asyncDispose]() {
			return disposeHosts(this.entries.map((entry) => entry.workspace));
		},
	});
}

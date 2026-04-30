/**
 * Workspace config loader.
 *
 * `epicenter.config.ts` is a daemon host manifest. The loader reads the
 * default `defineEpicenterConfig([...])` export, awaits each hosted workspace,
 * validates route keys, and returns the internal `WorkspaceEntry[]` used by the
 * daemon server.
 */

import { join, resolve } from 'node:path';
import type { PeerAwarenessState } from '@epicenter/workspace';
import {
	EPICENTER_CONFIG,
	type HostedWorkspace,
	type LoadedWorkspace,
	type WorkspaceEntry,
} from '@epicenter/workspace/daemon';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

export const CONFIG_FILENAME = 'epicenter.config.ts';

export type { HostedWorkspace, LoadedWorkspace, WorkspaceEntry };

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
			`default export must be defineEpicenterConfig([...]).`,
		configPath,
	}),
	EmptyConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`No daemon hosts found in ${configPath}.\n` +
			`Default-export defineEpicenterConfig([...]) with at least one host.`,
		configPath,
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
			`expected route, actions, and [Symbol.dispose].`,
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

function isHostedWorkspace(value: unknown): value is HostedWorkspace {
	if (value == null || typeof value !== 'object') return false;
	const record = value as Record<PropertyKey, unknown>;
	return (
		typeof record.route === 'string' &&
		typeof record.actions === 'object' &&
		record.actions !== null &&
		!Array.isArray(record.actions) &&
		typeof record[Symbol.dispose] === 'function'
	);
}

function isValidRoute(route: string): boolean {
	return ROUTE_PATTERN.test(route) && !OBJECT_DANGEROUS_ROUTE_KEYS.has(route);
}

async function disposeHosts(hosts: HostedWorkspace[]): Promise<void> {
	const barriers: Promise<unknown>[] = [];
	for (const host of hosts) {
		if (host.sync?.whenDisposed) barriers.push(host.sync.whenDisposed);
		host[Symbol.dispose]();
	}
	await Promise.all(barriers);
}

async function disposeConfig(config: LoadConfigResult): Promise<void> {
	await disposeHosts(config.entries.map((entry) => entry.workspace));
}

/**
 * Load daemon hosts from an explicit default config export.
 */
export async function loadConfig(
	targetDir: string,
): Promise<Result<LoadConfigResult, LoadError>> {
	const configPath = join(resolve(targetDir), CONFIG_FILENAME);

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

	const hosts: HostedWorkspace[] = [];
	const routes = new Set<string>();

	for (const [index, input] of config.hosts.entries()) {
		let host: unknown;
		try {
			host = await input;
		} catch (cause) {
			await disposeHosts(hosts);
			return LoadError.HostFailed({ configPath, index, cause });
		}

		if (!isHostedWorkspace(host)) {
			await disposeHosts(hosts);
			return LoadError.InvalidHost({ configPath, index });
		}

		if (!isValidRoute(host.route)) {
			await disposeHosts([...hosts, host]);
			return LoadError.InvalidRoute({ configPath, route: host.route });
		}

		if (routes.has(host.route)) {
			await disposeHosts([...hosts, host]);
			return LoadError.DuplicateRoute({ configPath, route: host.route });
		}

		routes.add(host.route);
		hosts.push(host);
	}

	const entries = hosts.map((host) => ({
		route: host.route,
		workspace: host,
	}));

	return Ok({
		entries,
		[Symbol.asyncDispose]() {
			return disposeConfig(this);
		},
	});
}

/**
 * Workspace config loader.
 *
 * `epicenter.config.ts` is a project config with daemon routes. The loader
 * reads the default `{ daemon: { routes } }` export, validates route names,
 * starts route modules with project context, and returns the route runtimes
 * used by the daemon server.
 */

import { join, resolve } from 'node:path';
import type { PeerAwarenessState, ProjectDir } from '@epicenter/workspace';
import {
	type DaemonRouteModule,
	type DaemonRuntime,
	type DaemonRouteRuntime,
} from '@epicenter/workspace/daemon';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result, tryAsync } from 'wellcrafted/result';

export const CONFIG_FILENAME = 'epicenter.config.ts';

export type { DaemonRuntime, DaemonRouteRuntime };

/** Per-peer awareness state under the standard peer schema. */
export type AwarenessState = PeerAwarenessState;

export type LoadConfigResult = {
	runtimes: DaemonRouteRuntime[];
	/**
	 * Release every daemon runtime. Teardown starts by destroying the Y.Doc,
	 * then the loader awaits sync teardown barriers exposed by each runtime.
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
			`default export must be { daemon: { routes: {...} } }.`,
		configPath,
	}),
	EmptyConfig: ({ configPath }: { configPath: string }) => ({
		message:
			`No daemon routes found in ${configPath}.\n` +
			`Default-export { daemon: { routes: {...} } } with at least one route.`,
		configPath,
	}),
	InvalidRouteModule: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`expected a route module function.`,
		configPath,
		route,
	}),
	RouteFailed: ({
		configPath,
		route,
		cause,
	}: {
		configPath: string;
		route: string;
		cause: unknown;
	}) => ({
		message:
			`Failed to initialize daemon route "${route}" in ${configPath}: ` +
			extractErrorMessage(cause),
		configPath,
		route,
		cause,
	}),
	InvalidRouteRuntime: ({
		configPath,
		route,
	}: {
		configPath: string;
		route: string;
	}) => ({
		message:
			`Invalid daemon route "${route}" in ${configPath}: ` +
			`expected a daemon runtime with actions, sync teardown/status, ` +
			`presence peers/observe/waitForPeer, rpc.rpc, and [Symbol.dispose].`,
		configPath,
		route,
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
});
export type LoadError = InferErrors<typeof LoadError>;

function hasDaemonRuntimeShape(value: unknown): value is DaemonRuntime {
	if (!isObjectRecord(value)) return false;
	const { actions, sync, presence, rpc } = value;
	if (!isObjectRecord(sync) || !isObjectRecord(presence) || !isObjectRecord(rpc)) {
		return false;
	}
	return (
		isObjectRecord(actions) &&
		isThenable(sync.whenDisposed) &&
		typeof sync.onStatusChange === 'function' &&
		typeof presence.peers === 'function' &&
		typeof presence.observe === 'function' &&
		typeof presence.waitForPeer === 'function' &&
		typeof rpc.rpc === 'function' &&
		typeof value[Symbol.dispose] === 'function'
	);
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === 'object' || typeof value === 'function') &&
		typeof (value as { then?: unknown }).then === 'function'
	);
}

function isValidRoute(route: string): boolean {
	return ROUTE_PATTERN.test(route) && !OBJECT_DANGEROUS_ROUTE_KEYS.has(route);
}

async function disposeRuntimes(runtimes: DaemonRuntime[]): Promise<void> {
	const barriers: Promise<unknown>[] = [];
	for (const runtime of runtimes) {
		barriers.push(runtime.sync.whenDisposed);
		runtime[Symbol.dispose]();
	}
	await Promise.all(barriers);
}

/**
 * Load daemon route modules from the explicit default project config.
 */
export async function loadConfig(
	targetDir: string,
): Promise<Result<LoadConfigResult, LoadError>> {
	const projectDir = resolve(targetDir) as ProjectDir;
	const configPath = join(projectDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		return LoadError.MissingFile({ configPath });
	}

	const importResult = await tryAsync({
		try: () => import(Bun.pathToFileURL(configPath).href),
		catch: (cause) => LoadError.ImportFailed({ configPath, cause }),
	});
	if (importResult.error) return importResult;

	const config = (importResult.data as { default?: unknown }).default;
	if (
		!isObjectRecord(config) ||
		!isObjectRecord(config.daemon) ||
		!isObjectRecord(config.daemon.routes)
	) {
		return LoadError.InvalidConfig({ configPath });
	}
	const routeModules = Object.entries(config.daemon.routes);
	if (routeModules.length === 0) return LoadError.EmptyConfig({ configPath });

	const definitions: { route: string; module: DaemonRouteModule }[] = [];
	for (const [route, routeModule] of routeModules) {
		if (!isValidRoute(route)) {
			return LoadError.InvalidRoute({ configPath, route });
		}
		if (typeof routeModule !== 'function') {
			return LoadError.InvalidRouteModule({ configPath, route });
		}
		definitions.push({ route, module: routeModule as DaemonRouteModule });
	}

	const runtimes: DaemonRouteRuntime[] = [];

	for (const definition of definitions) {
		let runtime: unknown;
		try {
			runtime = await definition.module({
				projectDir,
				route: definition.route,
			});
		} catch (cause) {
			await disposeRuntimes(runtimes.map((entry) => entry.runtime));
			return LoadError.RouteFailed({
				configPath,
				route: definition.route,
				cause,
			});
		}

		if (!hasDaemonRuntimeShape(runtime)) {
			await disposeRuntimes(runtimes.map((entry) => entry.runtime));
			return LoadError.InvalidRouteRuntime({
				configPath,
				route: definition.route,
			});
		}

		runtimes.push({
			route: definition.route,
			runtime,
		});
	}

	return Ok({
		runtimes,
		[Symbol.asyncDispose]() {
			return disposeRuntimes(this.runtimes.map((entry) => entry.runtime));
		},
	});
}

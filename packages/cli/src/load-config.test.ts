import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILENAME, loadConfig } from './load-config';

let workDir: string;
const daemonModuleUrl = pathToFileURL(
	join(import.meta.dir, '../../workspace/src/daemon/index.ts'),
).href;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'ep-load-config-'));
	delete (globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents;
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
	delete (globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents;
});

function writeConfig(source: string) {
	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, CONFIG_FILENAME), source);
}

const daemonTransportFields = `
	sync: {
		whenDisposed: Promise.resolve(),
		onStatusChange: () => () => {}
	},
	presence: {
		peers: () => new Map(),
		observe: () => () => {},
		waitForPeer: async () => ({
			data: null,
			error: {
				name: 'PeerMiss',
				message: 'missing peer',
				peerTarget: 'missing',
				sawPeers: false,
				waitMs: 1,
				emptyReason: null
			}
		})
	},
	rpc: {
		rpc: async () => ({ data: null, error: null })
	},
`;

const daemonRuntimeFields = `
	workspaceId: 'epicenter.demo',
	${daemonTransportFields}
`;

describe('loadConfig', () => {
	test('loads default defineEpicenterConfig hosts by route', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => ({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries.map((entry) => entry.route)).toEqual(['demo']);
		expect(result.data?.entries.map((entry) => entry.workspace.workspaceId)).toEqual(
			['epicenter.demo'],
		);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('passes project context into host definitions', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: ({ projectDir }) => ({
							actions: {
								paths: {
									projectDir: { handler: () => projectDir }
								}
							},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		const paths = result.data?.entries[0]?.workspace.actions.paths as
			| {
					projectDir: { handler(): string };
			  }
			| undefined;
		expect(paths?.projectDir.handler()).toBe(workDir);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects duplicate definition routes before starting hosts', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => {
							globalThis.__loadConfigEvents.push('started:first');
							return {
								actions: {},
								${daemonRuntimeFields}
								[Symbol.dispose]() {}
							};
						}
					}),
					defineDaemon({
						route: 'demo',
						start: () => {
							globalThis.__loadConfigEvents.push('started:second');
							return {
								actions: {},
								${daemonRuntimeFields}
								[Symbol.dispose]() {}
							};
						}
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DuplicateRoute');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);
	});

	test('awaits async host definitions', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => Promise.resolve({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries[0]?.route).toBe('demo');
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects invalid route keys', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'bad.route',
						start: () => ({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
	});

	test('rejects host runtimes missing workspaceId', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => ({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidHost');
	});

	test('rejects duplicate routes', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => ({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					}),
					defineDaemon({
						route: 'demo',
						start: () => ({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DuplicateRoute');
	});

	test('cleans up resolved hosts when a later host rejects', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'first',
						start: () => ({
							actions: {},
							${daemonRuntimeFields}
							[Symbol.dispose]() {
								globalThis.__loadConfigEvents.push('disposed:first');
							}
						})
					}),
					defineDaemon({
						route: 'second',
						start: () => Promise.reject(new Error('boom'))
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('HostFailed');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual(['disposed:first']);
	});

	test('rejects host runtimes missing daemon peer methods', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						start: () => ({
							workspaceId: 'epicenter.demo',
							actions: {},
							sync: { whenDisposed: Promise.resolve() },
							presence: {},
							rpc: {},
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidHost');
	});

	test('rejects missing default config helper', async () => {
		writeConfig(`
			export const demo = {
				route: 'demo',
				actions: {},
				[Symbol.dispose]() {}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidConfig');
	});
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('loadConfig', () => {
	test('loads default defineEpicenterConfig daemon routes by route key', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: () => ({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries.map((entry) => entry.route)).toEqual(['demo']);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('passes project context and route into route modules', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: ({ projectDir, route }) => ({
							actions: {
								paths: {
									projectDir: { handler: () => projectDir },
									route: { handler: () => route }
								}
							},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		const paths = result.data?.entries[0]?.workspace.actions.paths as
			| {
					projectDir: { handler(): string };
					route: { handler(): string };
			  }
			| undefined;
		expect(paths?.projectDir.handler()).toBe(workDir);
		expect(paths?.route.handler()).toBe('demo');
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects invalid route keys before starting route modules', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						'bad.route': () => {
							globalThis.__loadConfigEvents.push('started');
							return {
								actions: {},
								${daemonTransportFields}
								[Symbol.dispose]() {}
							};
						}
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);
	});

	test('awaits async route modules', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: () => Promise.resolve({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries[0]?.route).toBe('demo');
		await result.data?.[Symbol.asyncDispose]();
	});

	test('loads structural default daemon route config without helper', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: {
						demo: () => ({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries[0]?.route).toBe('demo');
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects inherited daemon route config', async () => {
		writeConfig(`
			export default Object.create({
				daemon: {
					routes: {
						demo: () => ({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidConfig');
	});

	test('rejects non-function route modules', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: {}
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteModule');
	});

	test('rejects route runtimes missing actions', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: () => ({
							${daemonTransportFields}
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteRuntime');
	});

	test('cleans up resolved runtimes when a later route rejects', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						first: () => ({
							actions: {},
							${daemonTransportFields}
							[Symbol.dispose]() {
								globalThis.__loadConfigEvents.push('disposed:first');
							}
						}),
						second: () => Promise.reject(new Error('boom'))
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('RouteFailed');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual(['disposed:first']);
	});

	test('rejects route runtimes missing presence and rpc methods', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				daemon: {
					routes: {
						demo: () => ({
							actions: {},
							sync: { whenDisposed: Promise.resolve() },
							presence: {},
							rpc: {},
							[Symbol.dispose]() {}
						})
					}
				}
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteRuntime');
	});

	test('rejects missing default config', async () => {
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

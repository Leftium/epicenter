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
	test('loads helper config and passes context into route modules', async () => {
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
		expect(result.data?.entries.map((entry) => entry.route)).toEqual(['demo']);
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
			globalThis.__loadConfigEvents = [];

			export default {
				daemon: {
					routes: {
						'bad.route': () => {
							globalThis.__loadConfigEvents.push('started');
							throw new Error('invalid route module started');
						}
					}
				}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual([]);
	});

	test('loads structural async daemon route config without helper', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: {
						demo: () => Promise.resolve({
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

	test('rejects non-function route modules', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: {
						demo: {}
					}
				}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteModule');
	});

	test('rejects route runtimes missing daemon contract fields', async () => {
		writeConfig(`
			export default {
				daemon: {
					routes: {
						demo: () => ({
							actions: {}
						})
					}
				}
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRouteRuntime');
	});

	test('cleans up resolved runtimes when a later route rejects', async () => {
		writeConfig(`
			globalThis.__loadConfigEvents = [];

			export default {
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
			};
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('RouteFailed');
		expect(
			(globalThis as { __loadConfigEvents?: string[] }).__loadConfigEvents,
		).toEqual(['disposed:first']);
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

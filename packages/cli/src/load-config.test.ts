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

describe('loadConfig', () => {
	test('loads default defineEpicenterConfig hosts by route', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						open: () => ({
							route: 'demo',
							actions: {},
							[Symbol.dispose]() {}
						})
					})
				]
			});
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries.map((entry) => entry.route)).toEqual(['demo']);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('passes project context into host definitions', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						open: ({ projectDir, configDir }) => ({
							route: 'demo',
							actions: {
								paths: {
									projectDir: { handler: () => projectDir },
									configDir: { handler: () => configDir }
								}
							},
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
					configDir: { handler(): string };
			  }
			| undefined;
		expect(paths?.projectDir.handler()).toBe(workDir);
		expect(paths?.configDir.handler()).toBe(workDir);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects duplicate definition routes before opening hosts', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						open: () => {
							globalThis.__loadConfigEvents.push('opened:first');
							return { route: 'demo', actions: {}, [Symbol.dispose]() {} };
						}
					}),
					defineDaemon({
						route: 'demo',
						open: () => {
							globalThis.__loadConfigEvents.push('opened:second');
							return { route: 'demo', actions: {}, [Symbol.dispose]() {} };
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
						open: () => Promise.resolve({
							route: 'demo',
							actions: {},
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
						open: () => ({
							route: 'bad.route',
							actions: {},
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

	test('rejects duplicate routes', async () => {
		writeConfig(`
			import { defineDaemon, defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig({
				hosts: [
					defineDaemon({
						route: 'demo',
						open: () => ({ route: 'demo', actions: {}, [Symbol.dispose]() {} })
					}),
					defineDaemon({
						route: 'demo',
						open: () => ({ route: 'demo', actions: {}, [Symbol.dispose]() {} })
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
						open: () => ({
							route: 'first',
							actions: {},
							[Symbol.dispose]() {
								globalThis.__loadConfigEvents.push('disposed:first');
							}
						})
					}),
					defineDaemon({
						route: 'second',
						open: () => Promise.reject(new Error('boom'))
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

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
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig([
				{
					route: 'demo',
					actions: {},
					[Symbol.dispose]() {}
				}
			]);
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries.map((entry) => entry.route)).toEqual(['demo']);
		await result.data?.[Symbol.asyncDispose]();
	});

	test('awaits async host inputs', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig([
				Promise.resolve({
					route: 'asyncHost',
					actions: {},
					[Symbol.dispose]() {}
				})
			]);
		`);

		const result = await loadConfig(workDir);

		expect(result.error).toBeNull();
		expect(result.data?.entries[0]?.route).toBe('asyncHost');
		await result.data?.[Symbol.asyncDispose]();
	});

	test('rejects invalid route keys', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig([
				{
					route: 'bad.route',
					actions: {},
					[Symbol.dispose]() {}
				}
			]);
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('InvalidRoute');
	});

	test('rejects duplicate routes', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			export default defineEpicenterConfig([
				{ route: 'demo', actions: {}, [Symbol.dispose]() {} },
				{ route: 'demo', actions: {}, [Symbol.dispose]() {} }
			]);
		`);

		const result = await loadConfig(workDir);

		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('DuplicateRoute');
	});

	test('cleans up resolved hosts when a later host rejects', async () => {
		writeConfig(`
			import { defineEpicenterConfig } from '${daemonModuleUrl}';

			globalThis.__loadConfigEvents = [];

			export default defineEpicenterConfig([
				{
					route: 'first',
					actions: {},
					[Symbol.dispose]() {
						globalThis.__loadConfigEvents.push('disposed:first');
					}
				},
				Promise.reject(new Error('boom'))
			]);
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

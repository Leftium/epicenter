import { describe, expect, test } from 'bun:test';

import type { DaemonWorkspaceModule } from '../daemon/define-daemon-workspace.js';
import { defineConfig, type EpicenterConfig } from './define-config.js';

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	(<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected
		? 1
		: 2
		? true
		: false;

describe('defineConfig', () => {
	test('returns the config unchanged', () => {
		const route = {
			open: () => {
				throw new Error('test route should not open');
			},
		} satisfies DaemonWorkspaceModule;
		const config = { routes: [route] };

		expect(defineConfig(config)).toBe(config);
	});

	test('accepts an empty config', () => {
		expect(defineConfig({})).toEqual({});
	});
});

const inferred = defineConfig({});
export type InferredConfigIsEpicenterConfig = Expect<
	Equal<typeof inferred, EpicenterConfig>
>;

// @ts-expect-error routes must be daemon workspace modules.
defineConfig({ routes: [{ open: 1 }] });

// @ts-expect-error routes must be an array.
defineConfig({ routes: {} });

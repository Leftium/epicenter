import { defineConfig, type EpicenterConfig } from './define-config.js';

// `defineConfig` is `(config) => config`. The contract worth pinning is
// type inference, asserted below via @ts-expect-error and the Equal
// type-level test. The runtime identity behavior is JS-trivial and
// covered indirectly by load-project-config.test.ts.

type Expect<TValue extends true> = TValue;
type Equal<TActual, TExpected> =
	(<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected
		? 1
		: 2
		? true
		: false;

const inferred = defineConfig({});
export type InferredConfigIsEpicenterConfig = Expect<
	Equal<typeof inferred, EpicenterConfig>
>;

// @ts-expect-error route values must be daemon workspace definitions.
defineConfig({ daemon: { routes: { demo: { open: 1 } } } });

// @ts-expect-error route values must expose open().
defineConfig({ daemon: { routes: { demo: {} } } });

// @ts-expect-error routes must be a record.
defineConfig({ daemon: { routes: [] } });

// @ts-expect-error top-level routes are no longer accepted.
defineConfig({ routes: [] });

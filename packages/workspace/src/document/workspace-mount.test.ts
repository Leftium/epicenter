/**
 * `definition.mount(...)` coordinator tests.
 *
 * `.mount()` is a pure coordinator over an injected node runtime, so these
 * tests inject a stub `NodeMountRuntime` and assert what the coordinator hands
 * the runtime: the resolved base URL, the *composed* action set (never the base
 * actions when `compose` selects others), the materializer list drained on
 * teardown, and the exposed handles. No node:* or bun:* modules are touched.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import type { SessionMountContext } from '../daemon/define-mount.js';
import type { NodeMountRuntime } from '../daemon/mount-runtime.js';
import { defineActions, defineQuery } from '../shared/actions.js';
import { defineTable } from './define-table.js';
import { defineWorkspace } from './workspace.js';

const demoWorkspace = defineWorkspace({
	id: 'epicenter-demo',
	tables: {
		items: defineTable({ id: field.string(), label: field.string() }),
	},
	kv: {},
	actions: ({ tables }) =>
		defineActions({
			items_count: defineQuery({
				description: 'Count items',
				handler: () => tables.items.storedCount(),
			}),
		}),
});

/** What the stub `attachInfrastructure` captured from the coordinator. */
type AttachSpy = {
	baseURL?: string;
	actions?: Record<string, unknown>;
	materializers?: ReadonlyArray<{ whenDisposed: Promise<void> }>;
};

/**
 * A stub node runtime: `defineSessionMount` passes through (so the test calls
 * `open(ctx)` directly), and `attachInfrastructure` records its options instead
 * of touching disk or sockets. The materializer helpers return fixed
 * single-action registries so the merge is observable.
 */
function stubRuntime(spy: AttachSpy): NodeMountRuntime {
	return {
		defineSessionMount: (mount: {
			name: string;
			open: (c: SessionMountContext) => unknown;
		}) => ({ name: mount.name, open: mount.open }),
		resolveBaseURL: (explicit?: string) => explicit ?? 'https://hosted.example',
		attachInfrastructure: (
			ydoc: { destroy(): void },
			_ctx: SessionMountContext,
			opts: {
				baseURL: string;
				actions: Record<string, unknown>;
				materializers?: ReadonlyArray<{ whenDisposed: Promise<void> }>;
			},
		) => {
			spy.baseURL = opts.baseURL;
			spy.actions = opts.actions;
			spy.materializers = opts.materializers;
			return {
				actions: opts.actions,
				yjsLog: { whenDisposed: Promise.resolve() },
				collaboration: { whenDisposed: Promise.resolve() },
				async [Symbol.asyncDispose]() {
					ydoc.destroy();
				},
			};
		},
		bind: () => ({
			sqlite: () => ({
				whenDisposed: Promise.resolve(),
				actions: { sqlite_rebuild: {} },
				client: {},
			}),
			markdown: () => ({
				whenDisposed: Promise.resolve(),
				actions: { markdown_rebuild: {} },
			}),
		}),
		// The stub is intentionally looser than the real runtime types.
	} as unknown as NodeMountRuntime;
}

/** A stub session context; the coordinator only forwards it. */
const ctx = {
	epicenterRoot: '/tmp/epicenter-root',
	mount: 'demo',
	nodeId: 'node-fixture',
	session: {
		ownerId: 'owner-fixture',
		openWebSocket: () => {},
		onReconnectSignal: () => () => {},
		fetch: async () => new Response(),
	},
} as unknown as SessionMountContext;

// biome-ignore lint/suspicious/noExplicitAny: the coordinator return is a daemon runtime read structurally here.
const open = (mount: { open: (c: SessionMountContext) => unknown }): any =>
	mount.open(ctx);

describe('definition.mount', () => {
	test('without compose: serves base actions, no materializers, falls back to hosted URL', () => {
		const spy: AttachSpy = {};
		const mount = demoWorkspace.mount({
			name: 'demo',
			runtime: stubRuntime(spy),
		});

		expect(mount.name).toBe('demo');
		const runtime = open(mount);

		expect(spy.baseURL).toBe('https://hosted.example');
		expect(Object.keys(spy.actions ?? {})).toEqual(['items_count']);
		expect(spy.materializers).toEqual([]);
		expect(runtime.actions).toBe(spy.actions);
		expect(typeof runtime[Symbol.asyncDispose]).toBe('function');
	});

	test('with compose: serves the composed action set, tracks materializers, exposes handles', () => {
		const spy: AttachSpy = {};
		const mount = demoWorkspace.mount({
			name: 'demo',
			baseURL: 'https://explicit.example',
			runtime: stubRuntime(spy),
			compose: ({ workspace, runtime }) => {
				const sqlite = runtime.sqlite(workspace);
				const markdown = runtime.markdown(workspace, { tables: { items: {} } });
				return {
					expose: { markdown },
					materializers: [sqlite, markdown],
					actions: defineActions({
						...workspace.actions,
						...sqlite.actions,
						...markdown.actions,
					}),
				};
			},
		});

		const runtime = open(mount);

		// The explicit base URL wins over the env/hosted fallback.
		expect(spy.baseURL).toBe('https://explicit.example');
		// The served set is the composed one: base + both materializers.
		expect(Object.keys(spy.actions ?? {}).sort()).toEqual([
			'items_count',
			'markdown_rebuild',
			'sqlite_rebuild',
		]);
		// Both materializers are listed for ordered teardown.
		expect(spy.materializers).toHaveLength(2);
		// `expose` is surfaced on the daemon runtime.
		expect(runtime.markdown).toBeDefined();
		// The runtime serves exactly what infrastructure was handed.
		expect(runtime.actions).toBe(spy.actions);
	});
});

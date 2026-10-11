/**
 * App Header Mounted Tests
 *
 * Mounts the real `AppHeader` in jsdom over the real Todos owner on the
 * in-memory OPFS stand-in.
 *
 * Key behaviors:
 * - A folder that syncs offers Sync in place of Pull, Merge incoming
 *   changes, and Commit and push
 * - A folder that does not sync yet, as on the desktop, keeps those actions
 *   and offers no Sync
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import '../../lib/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from '../../../../../packages/folder/src/browser-storage.test-support.js';
import { todosDefinition } from '../../lib/definition.js';
import type { TodosFolder } from '../../lib/platform/types.js';
import type { Todos } from '../../lib/todos.svelte.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createTodos } = await import('../../lib/todos.svelte.ts');
const { default: AppHeaderHost } = await import('./fixtures/AppHeaderHost.svelte');

let count = 0;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(adapt: (folder: TodosFolder) => TodosFolder = (f) => f) {
	const folder = expectOk(
		await openFolder({
			id: `app-header-${count++}`,
			definition: todosDefinition,
			browser: { ...testBrowserStorage() },
		}),
	);
	const todos: Todos = createTodos(adapt(folder));
	cleanup.push(() => todos.close());
	await todos.check();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(AppHeaderHost, { target, props: { todos } });
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	return target;
}

const testids = (target: HTMLElement) =>
	['sync', 'pull', 'commit-and-push'].filter(
		(id) => target.querySelector(`[data-testid="${id}"]`) !== null,
	);

test('a folder that syncs offers Sync in place of Pull and Commit and push', async () => {
	expect(testids(await setup())).toEqual(['sync']);
});

test('a folder that does not sync yet keeps Pull and Commit and push', async () => {
	const target = await setup((folder) => ({
		...folder,
		sync: { ...folder.sync, supported: false },
	}));
	expect(testids(target)).toEqual(['pull', 'commit-and-push']);
});

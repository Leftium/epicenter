import { requireIdentity } from '@epicenter/auth';
import {
	createSession,
	fromTable,
	type InferWorkspace,
} from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { auth } from '$platform/auth';
import { openFuji } from '../routes/(signed-in)/fuji/browser';
import type { EntryId } from '../routes/(signed-in)/fuji/workspace';

export const session = createSession({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const fuji = openFuji({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Fuji',
				platform: 'web',
			},
			openWebSocket: auth.openWebSocket,
			encryptionKeys: () => requireIdentity(auth).encryptionKeys,
		});
		const entriesMap = fromTable(fuji.tables.entries);
		const active = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt === undefined),
		);
		const deleted = $derived(
			[...entriesMap.values()].filter((e) => e.deletedAt !== undefined),
		);
		return {
			userId,
			fuji,
			entries: {
				get: (id: EntryId) => entriesMap.get(id),
				get active() {
					return active;
				},
				get deleted() {
					return deleted;
				},
			},
			[Symbol.dispose]() {
				entriesMap[Symbol.dispose]();
				fuji[Symbol.dispose]();
			},
		};
	},
});

export type FujiWorkspace = InferWorkspace<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

/**
 * Returns the live workspace payload for this app.
 *
 * Throws when `session.current` is null (no authenticated identity). The
 * typical caller is a `+page.svelte` mounted under the layout's
 * `{#if current}` gate; the layout has already proven the precondition by the
 * time the page mounts. If a route or component slips past that gate, or a
 * callback fires after the workspace was disposed, the throw surfaces the
 * misuse loudly.
 *
 * Bind once at script init and dot-access fields:
 *
 * ```ts
 * const workspace = requireWorkspace();
 * // then use workspace.fuji.X, workspace.entries.active, etc.
 * ```
 *
 * Do NOT inline the call into templates (`{#each requireWorkspace().entries.active}`):
 * that re-evaluates the helper on every reactive update and interacts badly
 * with teardown. Bind once matches the codebase rule for reactive accessors
 * (memory: feedback_no_destructure_reactive.md).
 */
export function requireWorkspace() {
	const c = session.current;
	if (!c) {
		throw new Error(
			'[fuji] requireWorkspace() called without an authenticated session. ' +
				'This indicates a route or component mounted without the layout gate, ' +
				'or a callback firing after the workspace was disposed.',
		);
	}
	return c.workspace;
}

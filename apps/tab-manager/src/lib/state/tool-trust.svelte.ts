/**
 * Reactive tool trust state backed by the workspace's toolTrust table.
 *
 * The table is a presence set of auto-approved tool names: a row means
 * "always allow", no row means "ask" (the safe default), so revoking
 * deletes the row instead of writing a junk default. Mutation tools start
 * absent and show approval UI in chat; "Always Allow" adds the row and
 * future invocations auto-approve. Query tools never consult this module:
 * they auto-execute always.
 *
 * Trust state syncs across devices via the workspace's Y.Doc CRDT.
 *
 * @module
 */

import { fromTable } from '@epicenter/svelte';
import type { TabManagerBrowser } from '$lib/tab-manager/extension';

export type ToolTrustState = ReturnType<typeof createToolTrustState>;

export function createToolTrustState(tabManager: TabManagerBrowser) {
	const trustView = fromTable(tabManager.tables.toolTrust);

	/** Cached projection of trusted tool names: stable reference via $derived. */
	const trustedNames = $derived(trustView.all.map((row) => row.id));

	return {
		/**
		 * Whether a tool auto-approves without showing the approval UI.
		 * Query tools should not call this because they auto-execute always.
		 *
		 * Honors only a trust row this binary can read: a grant written by a newer
		 * binary (a future toolTrust schema) is unreadable here, so it falls back
		 * to the safe "ask" default rather than auto-approving a row whose fields
		 * it cannot see.
		 */
		shouldAutoApprove(name: string): boolean {
			return trustView.byId(name) !== undefined;
		},

		/** Auto-approve this tool from now on (the "Always Allow" action). */
		allow(name: string): void {
			tabManager.tables.toolTrust.set({ id: name });
		},

		/** Return this tool to the ask-every-time default. */
		revoke(name: string): void {
			tabManager.tables.toolTrust.delete(name);
		},

		/** Names of all auto-approved tools, as a cached reactive array. */
		get trustedToolNames(): readonly string[] {
			return trustedNames;
		},
	};
}

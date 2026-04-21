import type { SyncStatus } from '@epicenter/document/attach-sync';

/**
 * Sync surface the `AccountPopover` consumes. Intersection of what both the
 * legacy extension-chain client (`workspace.extensions.sync`) and the new
 * `defineWorkspace` bundle (`workspace.sync`) expose, so apps can migrate
 * incrementally without a compat shim.
 */
export type SyncView = {
	readonly status: SyncStatus;
	reconnect: () => void;
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
};

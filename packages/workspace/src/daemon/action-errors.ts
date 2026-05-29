/**
 * Domain errors for daemon action routes.
 *
 * Local invoke and peer dispatch deliberately use separate response types:
 * local invoke executes this daemon's action registry, while peer dispatch
 * asks a recipient device to decide whether it supports the action.
 *
 * Remote call failures keep the remote client error intact so the CLI owns
 * every presentation choice for peer disconnects, timeouts, and other
 * wire-level RPC errors.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

import type { DispatchError } from '../document/dispatch.js';
import type {
	SyncError,
	SyncFailedReason,
} from '../document/internal/sync-supervisor.js';

type PeerDispatchRemoteError = Exclude<
	DispatchError,
	{ name: 'RecipientOffline' }
>;

export type PeerDispatchSyncStatus =
	| { phase: 'offline' }
	| {
			phase: 'connecting';
			retries: number;
			lastErrorType?: SyncError['type'];
	  }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

export const InvokeError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	RuntimeError: ({ cause }: { cause: unknown }) => ({
		message: extractErrorMessage(cause),
		cause,
	}),
});
export type InvokeError = InferErrors<typeof InvokeError>;

/**
 * CLI-specific failures of peer dispatch. Carrying the failure mode in-band
 * lets the renderer set `process.exitCode` from a single switch, even when the
 * result arrived over IPC.
 *
 * - `UsageError`: bad action key / missing sync; renderer exitCode=1.
 * - `PeerNotFound`: `--peer <target>` did not resolve within `--wait`;
 *   renderer exitCode=3.
 * - `RemoteCallFailed`: peer resolved but the RPC call itself failed
 *   (timeout, peer disconnected mid-call, wire error); renderer exitCode=2.
 */
export const PeerDispatchError = defineErrors({
	UsageError: ({
		message,
		suggestions,
	}: {
		message: string;
		suggestions?: string[];
	}) => ({ message, suggestions }),
	PeerNotFound: ({
		to,
		waitMs,
		syncStatus,
	}: {
		to: string;
		waitMs: number;
		syncStatus: PeerDispatchSyncStatus;
	}) => ({
		message: `no peer matches peer id "${to}"`,
		to,
		waitMs,
		syncStatus,
	}),
	RemoteCallFailed: ({
		cause,
		to,
		syncStatus,
	}: {
		to: string;
		cause: PeerDispatchRemoteError;
		syncStatus: PeerDispatchSyncStatus;
	}) => ({
		message: `remote call failed: ${cause.name}`,
		cause,
		to,
		syncStatus,
	}),
});
export type PeerDispatchError = InferErrors<typeof PeerDispatchError>;

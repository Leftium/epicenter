/**
 * Domain errors and response envelope for the `/run` route.
 *
 * Lives daemon-side because the route owns the wire contract: `executeRun`
 * constructs `RunError` variants in `run-handler.ts`, and the response
 * envelope (`RunResponse`) is what the route serializes to JSON. The CLI
 * command imports both for renderer typing.
 *
 * `PeerMiss` is normalized into `RunError` at the `/run` boundary so the
 * daemon route owns every run-specific failure the CLI renders.
 */

import type { RpcError } from '@epicenter/sync';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import type { PeerAwarenessState as AwarenessState } from '../document/standard-awareness-defs.js';
import type { ResolveError } from './resolve-entry.js';

/**
 * CLI-specific failures of the `/run` route. Carrying the failure mode
 * in-band lets the renderer set `process.exitCode` from a single switch,
 * even when the result arrived over IPC.
 *
 * - `UsageError`: bad action path / missing sync; renderer exitCode=1.
 * - `RuntimeError`: action returned Err locally; renderer exitCode=2.
 * - `RpcError`: remote RPC returned an `RpcError`; exitCode=2.
 * - `PeerMiss`: `--peer <target>` did not resolve within the wait budget;
 *   renderer exitCode=3.
 */
export const RunError = defineErrors({
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
	RpcError: ({
		cause,
		targetClientId,
		peerState,
	}: {
		cause: RpcError;
		targetClientId: number;
		peerState: AwarenessState;
	}) => ({
		message: `RPC failed: ${cause.name}`,
		cause,
		targetClientId,
		peerState,
	}),
	PeerMiss: ({
		peerTarget,
		sawPeers,
		waitMs,
		emptyReason,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		waitMs: number;
		emptyReason: string | null;
	}) => ({
		message: `no peer matches deviceId "${peerTarget}"`,
		peerTarget,
		sawPeers,
		waitMs,
		emptyReason,
	}),
});
export type RunError = InferErrors<typeof RunError>;

/**
 * Wire shape of `/run`'s response body. Wider than `executeRun`'s actual
 * return type because the route prepends `ResolveError` for `-w` misses
 * before dispatching. The renderer narrows on `error.name`.
 */
export type RunResponse = Result<unknown, RunError | ResolveError>;

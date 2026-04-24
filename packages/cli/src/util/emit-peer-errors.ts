/**
 * Error emitters for `run --peer`.
 *
 * `emitMissError` formats the four peer-lookup miss shapes (case-suggest,
 * case-ambiguous, not-found with/without peers seen).
 *
 * `emitRpcError` formats the five `RpcError` variants (ActionNotFound,
 * Timeout, PeerOffline, ActionFailed, Disconnected) plus an unknown-shape
 * fallback — all labeled with whatever presence info the peer advertised
 * (deviceName, version) at resolution time.
 *
 * Kept separate from `run.ts` so the formatting is unit-testable without
 * standing up the full invoke pipeline.
 */

import { extractErrorMessage } from 'wellcrafted/error';
import type { FindPeerResult } from './find-peer';
import { outputError } from './format-output';
import type { AwarenessState } from './handle-attachments';

export function emitMissError(
	target: string,
	result: FindPeerResult,
	sawPeers: boolean,
	workspace: string | undefined,
	waitMs: number,
): void {
	const scope = workspace ? ` in workspace ${workspace}` : '';
	if (result.kind === 'case-suggest') {
		outputError(`error: no peer matches "${target}"${scope}`);
		outputError(`did you mean: ${result.actual}?`);
		return;
	}
	if (result.kind === 'case-ambiguous') {
		outputError(`error: no peer matches "${target}"${scope}`);
		outputError('multiple peers match case-insensitively:');
		for (const match of result.matches) {
			outputError(`  ${match.value.padEnd(16)} (${match.clientID})`);
		}
		return;
	}
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		return;
	}
	outputError(`error: no peer matches "${target}"${scope}`);
	const peersHint = workspace ? ` -w ${workspace}` : '';
	outputError(`run \`epicenter peers${peersHint}\` to see connected peers`);
}

export function emitRpcError(
	error: unknown,
	targetClientId: number,
	peerState: AwarenessState,
): void {
	if (error == null || typeof error !== 'object' || !('name' in error)) {
		outputError(`error: ${extractErrorMessage(error)}`);
		return;
	}
	const e = error as {
		name: string;
		action?: string;
		ms?: number;
		cause?: unknown;
	};
	const deviceName =
		typeof peerState.deviceName === 'string' ? peerState.deviceName : undefined;
	const version =
		typeof peerState.version === 'string' ? peerState.version : undefined;
	const peerLabel = formatPeerLabel(targetClientId, deviceName, version);

	switch (e.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${e.action}" on ${peerLabel}`);
			return;
		case 'Timeout':
			outputError(`error: timeout after ${e.ms}ms on ${peerLabel}`);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerLabel} is offline`);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${e.action}" failed on ${peerLabel}: ${extractErrorMessage(e.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerLabel} responded`);
			return;
		default:
			outputError(`error: ${extractErrorMessage(error)}`);
	}
}

function formatPeerLabel(
	clientId: number,
	deviceName: string | undefined,
	version: string | undefined,
): string {
	const idAndVersion = version ? `${clientId}, v${version}` : String(clientId);
	return deviceName ? `${deviceName} (${idAndVersion})` : `clientID ${clientId}`;
}

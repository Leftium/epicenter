/**
 * Error emitters for `run --peer`.
 *
 * `emitMissError` formats the two peer-lookup miss shapes (no peers seen,
 * peers seen but no deviceId match).
 *
 * `emitRpcError` formats every `RpcError` variant — labeled with whatever
 * presence info the peer advertised (`device.name`, `device.platform`) at
 * resolution time. The exhaustive switch is enforced at compile time via
 * the `never` check: adding a new variant to `@epicenter/sync`'s `RpcError`
 * breaks the CLI build until a case is added here.
 *
 * Kept separate from `run.ts` so the formatting is unit-testable without
 * standing up the full invoke pipeline.
 */

import type { RpcError } from '@epicenter/workspace';
import { extractErrorMessage } from 'wellcrafted/error';
import { outputError } from './format-output';
import type { AwarenessState } from './awareness';

export function emitMissError(
	target: string,
	sawPeers: boolean,
	workspace: string | undefined,
	waitMs: number,
): void {
	const scope = workspace ? ` in workspace ${workspace}` : '';
	if (!sawPeers) {
		outputError(
			`error: no peers seen after waiting ${waitMs}ms for "${target}"`,
		);
		return;
	}
	outputError(`error: no peer matches deviceId "${target}"${scope}`);
	const peersHint = workspace ? ` -w ${workspace}` : '';
	outputError(`run \`epicenter peers${peersHint}\` to see connected peers`);
}

export function emitRpcError(
	error: RpcError,
	targetClientId: number,
	peerState: AwarenessState,
): void {
	const device = peerState.device as
		| { name?: string; platform?: string }
		| undefined;
	const peerLabel = device?.name
		? `${device.name} (${targetClientId}${device.platform ? `, ${device.platform}` : ''})`
		: `clientID ${targetClientId}`;

	switch (error.name) {
		case 'ActionNotFound':
			outputError(`error: ActionNotFound "${error.action}" on ${peerLabel}`);
			return;
		case 'Timeout':
			outputError(`error: timeout after ${error.ms}ms on ${peerLabel}`);
			return;
		case 'PeerOffline':
			outputError(`error: peer ${peerLabel} is offline`);
			return;
		case 'PeerNotFound':
			outputError(`error: no peer with deviceId "${error.peer}"`);
			return;
		case 'PeerLeft':
			outputError(
				`error: peer "${error.peer}" disconnected before responding`,
			);
			return;
		case 'ActionFailed':
			outputError(
				`error: "${error.action}" failed on ${peerLabel}: ${extractErrorMessage(error.cause)}`,
			);
			return;
		case 'Disconnected':
			outputError(`error: connection lost before ${peerLabel} responded`);
			return;
		default: {
			const _exhaustive: never = error;
			void _exhaustive;
		}
	}
}

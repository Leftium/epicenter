/**
 * Peer-B mount for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-B is distinguishable from peer-A in the same
 * workspace.
 */

import { defineSessionMount } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineSessionMount({
	name: 'notes',
	open: ({ session }) =>
		openNotes({
			deviceId: 'notes-repro-peer-b',
			ownerId: session.ownerId,
			openWebSocket: session.openWebSocket,
			onReconnectSignal: session.onReconnectSignal,
		}),
});

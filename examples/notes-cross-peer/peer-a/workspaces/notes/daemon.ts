/**
 * Peer-A mount for the cross-peer sync repro. Uses a hard-coded
 * `deviceId` so peer-A is distinguishable from peer-B in the same
 * workspace.
 */

import { defineSessionMount } from '@epicenter/workspace/daemon';
import { openNotes } from '../../../notes';

export default defineSessionMount({
	name: 'notes',
	open: ({ session }) =>
		openNotes({
			deviceId: 'notes-repro-peer-a',
			ownerId: session.ownerId,
			openWebSocket: session.openWebSocket,
			onReconnectSignal: session.onReconnectSignal,
		}),
});

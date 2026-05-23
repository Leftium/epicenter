/**
 * Peer-A daemon for the cross-peer sync repro. Uses a hard-coded `clientId`
 * so peer-A is distinguishable from peer-B in the same workspace.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { openNotes } from '../../../notes';

export default defineWorkspace({
	open: ({ owner, openWebSocket, onReconnectSignal }) =>
		openNotes({
			clientId: 'notes-repro-peer-a',
			owner,
			openWebSocket,
			onReconnectSignal,
		}),
});

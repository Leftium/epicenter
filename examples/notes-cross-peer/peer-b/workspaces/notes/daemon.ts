/**
 * Peer-B daemon for the cross-peer sync repro. Uses a hard-coded `clientId`
 * so peer-B is distinguishable from peer-A in the same workspace.
 */

import { defineWorkspace } from '@epicenter/workspace';
import { openNotes } from '../../../notes';

export default defineWorkspace({
	open: ({ owner, openWebSocket, onReconnectSignal }) =>
		openNotes({
			clientId: 'notes-repro-peer-b',
			owner,
			openWebSocket,
			onReconnectSignal,
		}),
});

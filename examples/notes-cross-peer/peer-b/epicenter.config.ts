import { defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

export default defineEpicenterConfig({
	daemon: {
		routes: {
			notes: () =>
				openNotes({
					id: 'notes-repro-peer-b',
					name: 'Peer B',
					platform: 'node',
				}),
		},
	},
});

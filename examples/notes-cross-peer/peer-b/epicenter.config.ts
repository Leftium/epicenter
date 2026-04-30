import { defineDaemon, defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

const notes = openNotes({
	id: 'notes-repro-peer-b',
	name: 'Peer B',
	platform: 'node',
});

export default defineEpicenterConfig({
	hosts: [
		defineDaemon({
			route: 'notes',
			title: 'Notes',
			workspaceId: 'epicenter.notes-repro',
			open: () => ({
				...notes,
				route: 'notes',
			}),
		}),
	],
});

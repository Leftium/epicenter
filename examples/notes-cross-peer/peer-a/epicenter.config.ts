import { defineDaemon, defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

const notes = openNotes({
	id: 'notes-repro-peer-a',
	name: 'Peer A',
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

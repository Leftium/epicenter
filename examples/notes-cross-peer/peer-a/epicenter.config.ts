import {
	defineDaemon,
	defineEpicenterConfig,
} from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

export default defineEpicenterConfig({
	hosts: [
		defineDaemon({
			route: 'notes',
			title: 'Notes',
			workspaceId: 'epicenter.notes-repro',
			start: () =>
				openNotes({
					id: 'notes-repro-peer-a',
					name: 'Peer A',
					platform: 'node',
				}),
		}),
	],
});

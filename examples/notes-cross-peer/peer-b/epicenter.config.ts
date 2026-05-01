import { defineConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

export default defineConfig({
	daemon: {
		routes: [
			{
				route: 'notes',
				start: () =>
					openNotes({
						id: 'notes-repro-peer-b',
						name: 'Peer B',
						platform: 'node',
					}),
			},
		],
	},
});

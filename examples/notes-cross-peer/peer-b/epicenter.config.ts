import { defineConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

export default defineConfig({
	daemon: {
		routes: [
			{
				route: 'notes',
				start: () => openNotes('notes-repro-peer-b'),
			},
		],
	},
});

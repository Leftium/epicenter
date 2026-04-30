import { defineEpicenterConfig } from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

const notes = openNotes({
	id: 'notes-repro-peer-a',
	name: 'Peer A',
	platform: 'node',
});

export default defineEpicenterConfig([
	{
		...notes,
		route: 'notes',
	},
]);

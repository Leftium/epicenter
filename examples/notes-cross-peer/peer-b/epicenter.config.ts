import {
	defineDaemon,
	defineEpicenterConfig,
} from '@epicenter/workspace/daemon';
import { openNotes } from '../notes';

export default defineEpicenterConfig({
	hosts: [
		defineDaemon({
			route: 'notes',
			start: () =>
				openNotes({
					id: 'notes-repro-peer-b',
					name: 'Peer B',
					platform: 'node',
				}),
		}),
	],
});

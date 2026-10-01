/**
 * The browser leaf: a logical folder in this browser's IndexedDB, with the
 * same tables, files, and Git history as the desktop directory, and a shell
 * emulated over those files. Nothing native is imported here.
 */
import { openBrowserFolder } from '@epicenter/app/files';
import { createFolderTerminal } from '@epicenter/app/files/terminal';
import { honeycrispDefinition } from '../data.js';
import type { OpenNotesHost } from './types.js';

export const openNotesHost: OpenNotesHost = async () => {
	const folder = await openBrowserFolder({
		id: honeycrispDefinition.id,
		definition: honeycrispDefinition,
		git: { author: { name: 'Honeycrisp', email: 'honeycrisp@localhost' } },
	});
	const terminal = createFolderTerminal(folder);
	return {
		folder,
		terminal: {
			get cwd() {
				return terminal.cwd;
			},
			description:
				'The same files as the app · git status, diff, log; saves request history',
			exec: (command) => terminal.exec(command),
		},
		location: 'This browser',
		reveal: undefined,
		history: undefined,
		faults: undefined,
		// Only this page writes a browser folder; it rereads after its own work.
		onExternalChange: () => () => {},
		onCloseRequested: () => () => {},
		quit: async () => {},
		close: () => folder.close(),
	};
};

/**
 * The desktop leaf: the notes are a real directory the desktop shell owns.
 *
 * The folder comes from the shell's folder owner through
 * `@epicenter/folder/tauri`. The page names the folder's ID and nothing else:
 * the root, the commit author, and the history policy are the shell's.
 * Frontmatter and every draft stay in this page.
 *
 * The terminal is the shell's own `/bin/sh`, an outside writer, not the
 * folder's emulated one.
 *
 * A folder that cannot be opened is an error on screen. There is no other
 * store to fall back to: this entry refuses outside the desktop app.
 */
import { openFolder } from '@epicenter/folder/tauri';
import { honeycrispDefinition } from '../data.js';
import { setUpFolder } from './first-open.js';
import { openGuarded, openShellServices } from './shell.tauri.js';
import {
	HONEYCRISP_FOLDER_ID,
	type NotesHost,
	type OpenNotes,
} from './types.js';

async function acquire(): Promise<NotesHost> {
	const opened = await openFolder({
		id: HONEYCRISP_FOLDER_ID,
		definition: honeycrispDefinition,
	});
	if (opened.error) throw new Error(opened.error.message);
	const folder = opened.data;
	try {
		// The owner holds the directory now. An existing folder is left as it is.
		await setUpFolder(folder.files, Object.keys(honeycrispDefinition.tables));
		return {
			folder,
			...(await openShellServices()),
			close: () => folder.close(),
		};
	} catch (cause) {
		await folder.close();
		throw cause;
	}
}

export const openNotes: OpenNotes = (options) =>
	openGuarded({ ...options, acquire });

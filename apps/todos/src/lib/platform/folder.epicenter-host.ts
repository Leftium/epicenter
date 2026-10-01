/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * todos are a real directory owned by the shell's Rust folder plugin.
 * A page opens the folder the shell registered under the definition's ID;
 * closing it detaches this page. The shell keeps the directory, the author,
 * the remote, and the history policy. Imports acquire nothing, and a folder
 * that cannot be opened is a refusal, never IndexedDB.
 */
import { OpenFolderError, openFolder } from '@epicenter/folder/tauri';
import { todosDefinition } from '../definition.js';
import type { OpenTodosFolder } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = async () => {
	const opened = await openFolder({ definition: todosDefinition });
	if (opened.error) return opened;
	const folder = opened.data;
	const directory = await folder.files.mkdir('todos');
	if (directory.error) {
		await folder.close();
		return OpenFolderError.Unavailable({ cause: directory.error });
	}
	return opened;
};

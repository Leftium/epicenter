/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * todos are a real directory owned by the shell's Rust folder plugin.
 * A page opens the folder the shell registered under `TODOS_FOLDER_ID`;
 * closing it detaches this page. The shell keeps the directory, the author,
 * the remote, and the history policy. Imports acquire nothing, and a folder
 * that cannot be opened is a refusal; browser storage is not opened.
 */
import { OpenFolderError, openFolder } from '@epicenter/folder/tauri';
import { todosDefinition } from '../definition.js';
import { type OpenTodosFolder, TODOS_FOLDER_ID } from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openTodosFolder: OpenTodosFolder = async () => {
	const opened = await openFolder({
		id: TODOS_FOLDER_ID,
		definition: todosDefinition,
	});
	if (opened.error) return opened;
	const folder = opened.data;
	const { error: directoryError } = await folder.files.mkdir('todos');
	if (directoryError) {
		await folder.close();
		return OpenFolderError.Unavailable({ cause: directoryError });
	}
	return opened;
};

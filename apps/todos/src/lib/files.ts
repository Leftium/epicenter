/** App-owned file-name messages and the maximum size of editable text. */
import { type FolderFiles, pathProblem } from '@epicenter/folder';
import {
	joinPath,
	readTextFile as readFolderTextFile,
} from '@epicenter/folder/file-browser';

export function nameProblem(
	directory: string,
	name: string,
): string | undefined {
	if (name === '') return 'Enter a name.';
	if (name.includes('/')) return 'A name cannot contain "/".';
	const problem = pathProblem(joinPath(directory, name));
	return problem === undefined
		? undefined
		: `This name is not usable: ${problem}.`;
}

/** Text larger than this opens as file details instead of in the editor. */
export const EDITABLE_TEXT_LIMIT = 1024 * 1024;

/** Read editable text using this app's size limit. */
export function readTextFile(files: Pick<FolderFiles, 'read'>, path: string) {
	return readFolderTextFile(files, path, EDITABLE_TEXT_LIMIT);
}

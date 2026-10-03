/** Test helper: open a directory folder, failing the test when it is refused. */
import { expectOk } from 'wellcrafted/testing';
import {
	type DirectoryFolderOptions,
	type FolderDefinition,
	openFolder,
} from './bun.js';

export { openFolder };

export async function openNativeFolder<
	const TDefinition extends FolderDefinition,
>(options: DirectoryFolderOptions<TDefinition>) {
	return expectOk(await openFolder(options));
}

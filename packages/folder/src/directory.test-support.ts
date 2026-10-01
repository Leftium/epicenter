/** Test helper: open a directory folder, failing the test when it is refused. */
import type { DataDefinition } from '@epicenter/definition';
import { expectOk } from 'wellcrafted/testing';
import { type DirectoryFolderOptions, openFolder } from './bun.js';

export { openFolder };

export async function openNativeFolder<
	const TDefinition extends DataDefinition,
>(options: DirectoryFolderOptions<TDefinition>) {
	return expectOk(await openFolder(options));
}

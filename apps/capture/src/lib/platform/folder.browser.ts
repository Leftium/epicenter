/**
 * The browser leaf: a folder in this browser's OPFS, with local Git
 * history and no remote. It opens through the browser entry only, which
 * refuses inside the desktop app instead of opening storage there.
 *
 * Another tab of this app writes the same folder. The folder tells each tab
 * which paths the others saved, as a hint to reread; the page also rereads
 * when it regains focus.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import {
	CAPTURE_FOLDER_ID,
	type OpenCaptureHost,
	type OpenDeparture,
} from './types.js';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const { data: folder, error } = await openFolder({
		id: CAPTURE_FOLDER_ID,
		definition: captureDefinition,
		// History stays in this browser: a local author, a commit after each
		// save, and no remote to push to.
		browser: {
			author: { name: 'Capture', email: 'capture@localhost' },
			commitOnEdit: true,
		},
	});
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		onExternalChange: (listener) => folder.onFilesChanged(() => listener()),
		close: () => folder.close(),
	};
};

/** A tab has no host to quit; its leave warning covers a reload or a close. */
export const openDeparture: OpenDeparture = () => undefined;

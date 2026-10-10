/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory owned by the shell's Rust folder plugin. It
 * opens through the desktop entry only, which refuses outside the shell.
 *
 * The page names the folder by its ID and nothing else; the shell chose the
 * directory, the author, the history policy, and which windows may use it.
 * The collection finishes its intended saves before closing detaches this
 * page. The folder stays open for the shell and its other windows.
 *
 * A refused or missing plugin fails the open with its reason. There is no
 * browser folder to fall back to in this build.
 *
 * Quitting or restarting Epicenter asks this window first, through the
 * host's departure wire, bound to this window: its events are heard only
 * when sent to this window, and the host knows the caller by its window.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/tauri';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createDeparture } from './departure.svelte.js';
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
	});
	if (error) throw new Error(error.message, { cause: error });
	return {
		folder,
		location: folder.location,
		close: () => folder.close(),
	};
};

/** Called from a mounted component, before the folder opens. */
export const openDeparture: OpenDeparture = () => {
	const window = getCurrentWebviewWindow();
	return createDeparture({
		listen: (event, handler) => window.listen(event, () => handler()),
		invoke: (command, args) => invoke(command, args),
		onFocus(listener) {
			globalThis.addEventListener('focus', listener);
			return () => globalThis.removeEventListener('focus', listener);
		},
	});
};

/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory owned by the shell's Rust folder plugin. It
 * opens through the desktop entry only, which refuses outside the shell.
 *
 * The page names the folder by its ID and nothing else; the shell chose the
 * directory, the author, the history policy, and which windows may use it. Closing detaches this page: saves it
 * already made still land and are still committed, and the folder stays open
 * for the shell and its other windows.
 *
 * A refused or missing plugin fails the open with its reason. There is no
 * browser folder to fall back to in this build.
 */
import { captureDefinition } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/tauri';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
	createShellLifetime,
	type ShellLifetime,
	type ShellPort,
} from './shell-lifetime.js';
import type { OpenCaptureHost } from './types.js';

const tauriPort: ShellPort = {
	listen: (event, handler) =>
		listen<unknown>(event, ({ payload }) => handler(payload)),
	invoke: (command, args) => invoke(command, args),
};

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const opened = await openFolder({ definition: captureDefinition });
	if (opened.error)
		throw new Error(opened.error.message, { cause: opened.error });
	const folder = opened.data;

	let lifetime: ShellLifetime | undefined;
	try {
		lifetime = createShellLifetime(tauriPort);
		await lifetime.ready;
	} catch (cause) {
		// The page gets no host, so nothing would ever detach this session.
		lifetime?.close();
		await folder.close();
		throw cause;
	}
	const shell = lifetime;

	return {
		folder,
		location: folder.location,
		onExternalChange: (listener) => folder.onFilesChanged(() => listener()),
		onQuitRequested: shell.onQuitRequested,
		onServiceStopped: shell.onServiceStopped,
		get quitProtectionProblem() {
			return shell.quitProtectionProblem;
		},
		async close() {
			shell.close();
			await folder.close();
		},
	};
};

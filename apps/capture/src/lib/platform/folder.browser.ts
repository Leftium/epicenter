/**
 * The browser leaf: a logical folder in this browser's IndexedDB, with local
 * Git history and no remote. Nothing native is imported here.
 *
 * Another tab of this app writes the same folder. Each tab announces its
 * saves on a `BroadcastChannel`, which is a hint to reread and carries no
 * file contents; the page also rereads when it regains focus.
 */
import { openBrowserFolder } from '@epicenter/app/files';
import { captureDefinition } from '@epicenter/capture';
import type { CaptureFolder, OpenCaptureHost } from './types.js';

const CHANGES = 'epicenter.capture.files-changed';

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const opened = await openBrowserFolder({
		id: captureDefinition.id,
		definition: captureDefinition,
		git: { author: { name: 'Capture', email: 'capture@localhost' } },
	});
	const channel = new BroadcastChannel(CHANGES);
	const listeners = new Set<() => void>();
	channel.onmessage = () => {
		for (const listener of listeners) listener();
	};
	/** Run a write, then tell other tabs to reread if it reached the folder. */
	const announcing =
		<TArgs extends unknown[], TResult extends { error: unknown }>(
			write: (...args: TArgs) => Promise<TResult>,
		) =>
		async (...args: TArgs) => {
			const result = await write(...args);
			if (result.error === null) channel.postMessage(null);
			return result;
		};
	const { captures } = opened.tables;
	const folder: CaptureFolder = {
		tables: {
			captures: {
				list: () => captures.list(),
				get: (stem) => captures.get(stem),
				create: announcing((input) => captures.create(input)),
				writeSource: announcing((entry, source) =>
					captures.writeSource(entry, source),
				),
				delete: announcing((entry) => captures.delete(entry)),
			},
		},
		files: {
			read: (path) => opened.files.read(path),
			write: announcing((path, content, options) =>
				opened.files.write(path, content, options),
			),
		},
		git: opened.git,
	};
	return {
		folder,
		location: { kind: 'browser' },
		onExternalChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		// A tab has no quit request and no host process; its leave warning
		// covers a reload or a close.
		onQuitRequested: () => () => {},
		onHostStopped: () => () => {},
		quitProtectionProblem: undefined,
		async close() {
			channel.close();
			await opened.close();
		},
	};
};

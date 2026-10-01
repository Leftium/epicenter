/**
 * The browser workspace: a logical folder and its Git history in IndexedDB.
 *
 * The same tables, files, and history as the desktop folder, with no directory
 * behind them. The terminal is the in-page shell over those files, and
 * transcription requests go straight from the page, so the endpoint must allow
 * this origin.
 */
import { openBrowserFolder } from '@epicenter/app/files';
import { createFolderTerminal } from '@epicenter/app/files/terminal';
import { audioMimeTypeOf } from '../audio-format.js';
import {
	createFixtureDevice,
	createMicrophoneDevice,
	toneWav,
} from '../capture.js';
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	whisperingDefinition,
} from '../definition.js';
import { requestTranscription, TranscriptionError } from '../transcription.js';
import type { Workspace } from './types.js';

const KEY_STORAGE = 'whispering.transcriptionApiKey';

/**
 * A development build opened with `?fixture=tone` records a generated tone
 * instead of the microphone. A production build never does.
 */
function wantsToneFixture(): boolean {
	return (
		import.meta.env.DEV &&
		new URLSearchParams(location.search).get('fixture') === 'tone'
	);
}

export async function openBrowserWorkspace(): Promise<Workspace> {
	const folder = await openBrowserFolder({
		id: whisperingDefinition.id,
		definition: whisperingDefinition,
		git: { author: { name: 'Whispering', email: 'whispering@localhost' } },
	});

	return {
		kind: 'browser',
		folder,
		location: 'This browser’s storage for this site (IndexedDB)',
		terminal: createFolderTerminal(folder),
		terminalNote:
			'An in-page shell over the browser folder: common file commands, and git status, add, commit -m, diff, log.',
		capture: wantsToneFixture()
			? createFixtureDevice({
					name: 'generated tone',
					load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
				})
			: createMicrophoneDevice(),
		captureNotice: undefined,
		onExternalChange: () => () => {},
		reveal: undefined,
		async transcribe({ audioPath, baseUrl, model }) {
			const read = await folder.files.read(audioPath);
			if (read.error)
				return TranscriptionError.AudioUnreadable({
					path: audioPath,
					reason: read.error.message,
				});
			return requestTranscription({
				baseUrl,
				model,
				apiKey: localStorage.getItem(KEY_STORAGE) ?? '',
				audio: {
					bytes: read.data.bytes,
					filename: audioPath.slice(audioPath.lastIndexOf('/') + 1),
					mimeType: audioMimeTypeOf(audioPath) ?? 'application/octet-stream',
				},
			});
		},
		closing: undefined,
		credential: {
			storedIn: 'this browser’s local storage for this site',
			readOnlyReason: undefined,
			present: async () => (localStorage.getItem(KEY_STORAGE) ?? '') !== '',
			async set(key) {
				if (key === '') localStorage.removeItem(KEY_STORAGE);
				else localStorage.setItem(KEY_STORAGE, key);
				return undefined;
			},
		},
		initialSettings: DEFAULT_TRANSCRIPTION_SETTINGS,
		debugControls: import.meta.env.DEV,
		injection: undefined,
		close: () => folder.close(),
	};
}

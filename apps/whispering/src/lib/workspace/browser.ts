/**
 * The browser workspace: a logical folder and its Git history in IndexedDB.
 *
 * The same tables, files, and history as the desktop folder, with no directory
 * behind them. The terminal is the in-page shell over those files, and
 * transcription requests go straight from the page, so the endpoint must allow
 * this origin.
 *
 * The opener is the browser one, named explicitly. It refuses inside a
 * desktop app and where there is no IndexedDB, and that refusal is what the
 * person is shown: nothing else is opened in its place.
 */
import { openFolder } from '@epicenter/folder/browser';
import { Ok, type Result } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../audio-format.js';
import {
	createFixtureDevice,
	type MicrophonePreference,
	toneWav,
} from '../capture.js';
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	whisperingDefinition,
} from '../definition.js';
import { createMicrophoneDevice } from '../microphone.js';
import { requestTranscription, TranscriptionError } from '../transcription.js';
import {
	requestTransformation,
	TransformationError,
} from '../transformation.js';
import { type Workspace, WorkspaceError } from './types.js';

const KEY_STORAGE = 'whispering.transcriptionApiKey';
const MICROPHONE_STORAGE = 'whispering.microphone';

/** The microphone saved in this browser, or undefined when none is or it does not read as one. */
function savedMicrophone(): MicrophonePreference | undefined {
	try {
		const saved: unknown = JSON.parse(
			localStorage.getItem(MICROPHONE_STORAGE) ?? 'null',
		);
		if (
			typeof saved === 'object' &&
			saved !== null &&
			'deviceId' in saved &&
			typeof saved.deviceId === 'string' &&
			saved.deviceId !== '' &&
			'label' in saved &&
			typeof saved.label === 'string'
		)
			return { deviceId: saved.deviceId, label: saved.label };
	} catch {
		// Not ours to read.
	}
	return undefined;
}

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

export async function openBrowserWorkspace(): Promise<
	Result<Workspace, WorkspaceError>
> {
	const opened = await openFolder({
		definition: whisperingDefinition,
		browser: {
			author: { name: 'Whispering', email: 'whispering@localhost' },
		},
	});
	if (opened.error)
		return WorkspaceError.BrowserFolder({ refusal: opened.error });
	const folder = opened.data;

	return Ok({
		kind: 'browser',
		folder,
		location: 'This browser’s storage for this site (IndexedDB)',
		terminal: folder.terminal(),
		terminalNote:
			'An in-page shell over the browser folder: common file commands and git status, diff, log. Saves request history.',
		capture: wantsToneFixture()
			? createFixtureDevice({
					name: 'generated tone',
					load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
				})
			: createMicrophoneDevice(),
		captureNotice: undefined,
		// A hint to read again: this tab's saves and other tabs' on this origin.
		onExternalChange: (listener) => folder.onFilesChanged(() => listener()),
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
		async transform(request) {
			const answered = await requestTransformation({
				...request,
				apiKey: localStorage.getItem(KEY_STORAGE) ?? '',
			});
			// A browser reports a refused cross-origin request only as a failed
			// fetch, so say what a tab needs that the desktop app does not.
			if (answered.error?.name === 'Unreachable')
				return TransformationError.Unreachable({
					url: answered.error.url,
					reason: `${answered.error.reason}. In a browser tab the endpoint must allow requests from ${location.origin} (CORS). The desktop app sends from its folder host and has no such limit`,
				});
			return answered;
		},
		transformNote: `Requests are sent from this browser tab with the same API key as transcription, so the endpoint must allow requests from ${location.origin} (CORS). Most hosted providers refuse that; a local endpoint or the desktop app works.`,
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
		preferences: {
			microphone: async () => savedMicrophone(),
			async setMicrophone(microphone) {
				try {
					if (microphone === undefined)
						localStorage.removeItem(MICROPHONE_STORAGE);
					else
						localStorage.setItem(
							MICROPHONE_STORAGE,
							JSON.stringify(microphone),
						);
					return undefined;
				} catch (cause) {
					return cause instanceof Error ? cause.message : String(cause);
				}
			},
		},
		initialSettings: DEFAULT_TRANSCRIPTION_SETTINGS,
		debugControls: import.meta.env.DEV,
		injection: undefined,
		close: () => folder.close(),
	});
}

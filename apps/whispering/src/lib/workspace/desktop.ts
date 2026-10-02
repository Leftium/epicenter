/**
 * The desktop workspace: a real directory owned by the desktop shell, and the
 * Whispering host for everything else native.
 *
 * The folder is the shell's. The shell registered one directory for this
 * window, and this attaches to it through `@epicenter/folder/tauri`, naming
 * only the folder's ID. Saves, batches, history, and the hints that files
 * changed all come from that owner. The page supplies no path.
 *
 * The host that serves this page does the rest: the terminal is the person's
 * shell in that directory, transcription and transformation requests leave
 * from the host with the device key, the microphone chosen on this device is
 * kept beside that key, and the shell's close question arrives on the host's
 * event stream. The host holds no folder; what its terminal
 * writes reaches this page as the owner's hints, like any other program's.
 *
 * Both are required to open. A host that does not answer, an owner that
 * refuses, and the two naming different directories are each returned as that
 * refusal, and nothing else is opened in their place.
 *
 * Once open, the two fail apart. If the host stops, the folder is still the
 * shell's and still open: saves, batches, and commits keep working, and only
 * what the host did is unavailable. A reply the host never delivered says
 * nothing about whether it acted, so a lost transcription or transformation
 * reply is reported as unknown, never as "not sent", and nothing is sent again
 * on its own.
 */

import { openFolder } from '@epicenter/folder/tauri';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type BridgeConnection,
	createHttpBridge,
	type HttpBridge,
} from '../bridge/http.js';
import {
	type CaptureDevice,
	createFixtureDevice,
	type MicrophonePreference,
} from '../capture.js';
import { whisperingDefinition } from '../definition.js';
import { createMicrophoneDevice } from '../microphone.js';
import { TranscriptionError } from '../transcription.js';
import { TransformationError } from '../transformation.js';
import {
	type InjectionState,
	type Workspace,
	WorkspaceError,
} from './types.js';

/** What the host reports about itself. Mirrors `HostInfo` in `native/host.ts`. */
type HostInfo = {
	readonly root: string;
	readonly shell: string;
	readonly debug: boolean;
	readonly fixture: { readonly name: string; readonly size: number } | null;
	readonly fixtureRefused: boolean;
	readonly defaults: {
		readonly transcriptionBaseUrl: string;
		readonly transcriptionModel: string;
	};
	readonly credentialPresent: boolean;
	readonly credentialFromEnvironment: boolean;
};

/** What the host remembers for this device. Mirrors `DevicePreferences` in `native/host.ts`. */
type DevicePreferences = {
	readonly microphone: MicrophonePreference | null;
};

type ShellRun = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly cwd: string;
};

/** Raised in the page by the shell (`src-tauri/src/lib.rs`) when it cannot ask the host. */
const CLOSE_BLOCKED_EVENT = 'whispering:close-blocked';
/** The address the shell treats as "quit" once the host is gone. It is never loaded. */
const QUIT_PATH = '/__whispering__/quit';
const RECONNECT_MS = 500;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * Hear the shell's close question on the host's event stream until stopped.
 *
 * One stream at a time, connected again when it drops or cannot be reached.
 * The host repeats a question nobody has answered to every stream that
 * connects, so a dropped stream, or one that connects after the person asked,
 * loses none. Stopping ends the stream and the reconnecting; the returned
 * promise settles when both are over.
 */
function watchCloseRequests(
	bridge: HttpBridge,
	onRequest: () => void,
): () => Promise<void> {
	const stopping = new AbortController();
	const watching = (async () => {
		while (!stopping.signal.aborted) {
			try {
				await bridge.events((event) => {
					if (!stopping.signal.aborted && event.type === 'close-requested')
						onRequest();
				}, stopping.signal);
			} catch {
				// The host is unreachable for now; the loop tries again.
			}
			if (stopping.signal.aborted) return;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					stopping.signal.removeEventListener('abort', done);
					resolve();
				};
				const timer = setTimeout(done, RECONNECT_MS);
				stopping.signal.addEventListener('abort', done, { once: true });
			});
		}
	})();
	return () => {
		stopping.abort();
		return watching;
	};
}

/**
 * Let the window close when opening failed and nothing was opened.
 *
 * The shell holds back every close until the page answers, because a page may
 * hold unsaved work. A page whose workspace could not be opened holds none:
 * there is no session, no draft, no request, and no save in flight. But it
 * would also have nobody to answer, and the window could never be closed. So
 * once opening has failed, and only then, this answers each close the person
 * asks for: `proceed` through the host, or the quit address when the shell
 * says the host is gone.
 *
 * It answers requests; it never closes anything on its own. It must be
 * stopped before another opening is attempted, so it can never answer for a
 * session that holds work. Returns the function that stops it.
 */
export function answerCloseWithNothingOpen(
	connection: BridgeConnection,
): () => void {
	const bridge = createHttpBridge(connection);
	let stopped = false;
	const stopWatching = watchCloseRequests(bridge, () => {
		// Undeliverable: the window stays, and closing again asks again.
		void bridge.app('close', { decision: 'proceed' }).catch(() => {});
	});
	const quit = () => {
		if (!stopped) window.location.assign(`${connection.origin}${QUIT_PATH}`);
	};
	window.addEventListener(CLOSE_BLOCKED_EVENT, quit);
	return () => {
		stopped = true;
		window.removeEventListener(CLOSE_BLOCKED_EVENT, quit);
		void stopWatching();
	};
}

export async function openDesktopWorkspace(
	connection: BridgeConnection,
): Promise<Result<Workspace, WorkspaceError>> {
	const bridge = createHttpBridge(connection);
	// The host first: without it there is no app to open a folder for, so the
	// owner is not asked for anything.
	let info: HostInfo;
	try {
		info = await bridge.app<HostInfo>('info');
	} catch (cause) {
		return WorkspaceError.HostUnreachable({ reason: describe(cause) });
	}
	const opened = await openFolder({ definition: whisperingDefinition });
	if (opened.error)
		return WorkspaceError.DesktopFolder({ refusal: opened.error });
	const folder = opened.data;
	// The shell gave one directory to both. Were they to differ, the terminal
	// and transcription would use a directory the saves do not go to.
	const root = folder.location.kind === 'directory' ? folder.location.root : '';
	if (root !== info.root) {
		await folder.close();
		return WorkspaceError.FolderMismatch({ folder: root, host: info.root });
	}
	// The owner has opened the folder, so Git exists: a debug host may now take
	// the branch lock its launch asked for. The host reports a refusal itself.
	if (info.debug) await bridge.app('injection-launch').catch(() => {});

	// The folder-relative directory the next command starts in.
	let cwd = '';
	const shown = (relative: string) => (relative === '' ? '/' : `/${relative}`);

	const capture: CaptureDevice =
		info.fixture === null
			? createMicrophoneDevice()
			: createFixtureDevice({
					name: info.fixture.name,
					load: () =>
						bridge.app<{ name: string; bytes: Uint8Array }>('fixture'),
				});

	// The shell's close question, heard from here on for the workspace's
	// lifetime: over the host's event stream, and as a page event when the
	// host is gone. Nothing listens for either until the session has finished
	// starting, so one that arrives first is kept, not dropped, and handed to
	// the first listener.
	const closeListeners = new Set<() => void>();
	let closeAsked = false;
	const stopWatching = watchCloseRequests(bridge, () => {
		if (closeListeners.size === 0) closeAsked = true;
		for (const listener of closeListeners) listener();
	});
	const hostGoneListeners = new Set<() => void>();
	let closeAskedWithoutHost = false;
	const closeBlocked = () => {
		if (hostGoneListeners.size === 0) closeAskedWithoutHost = true;
		for (const listener of hostGoneListeners) listener();
	};
	window.addEventListener(CLOSE_BLOCKED_EVENT, closeBlocked);

	return Ok({
		kind: 'native',
		folder,
		location: root,
		terminal: {
			get cwd() {
				return shown(cwd);
			},
			async exec(command) {
				const run = await bridge.app<ShellRun>('terminal', { command, cwd });
				cwd = run.cwd;
				return run;
			},
		},
		terminalNote: `${info.shell} in ${root}. Each command is a new shell that starts in the directory the last one ended in; there is no interactive terminal device, so full-screen programs do not run.`,
		capture,
		captureNotice: info.fixtureRefused
			? 'WHISPERING_AUDIO_FIXTURE is set, but this build does not allow fixture audio. Recordings use the microphone.'
			: info.fixture?.size === 0
				? `The fixture file ${info.fixture.name} could not be read. Recordings will fail until it can.`
				: undefined,
		// The owner announces every change it sees: this window's saves, the
		// terminal's, and any other program's.
		onExternalChange: (listener) => folder.onFilesChanged(() => listener()),
		async reveal() {
			try {
				await bridge.app('reveal');
				return undefined;
			} catch (cause) {
				return describe(cause);
			}
		},
		// The bridge rejects when the host is unreachable, faults, or its reply is
		// lost; a workspace answers with a Result either way. A rejection does
		// not say the endpoint was not called, and the call is not made again.
		async transcribe({ audioPath, baseUrl, model }) {
			try {
				return await bridge.app<Awaited<ReturnType<Workspace['transcribe']>>>(
					'transcribe',
					{ path: audioPath, baseUrl, model },
				);
			} catch (cause) {
				return TranscriptionError.HostUnavailable({ reason: describe(cause) });
			}
		},
		async transform(request) {
			try {
				return await bridge.app<Awaited<ReturnType<Workspace['transform']>>>(
					'transform',
					request,
				);
			} catch (cause) {
				return TransformationError.HostUnavailable({ reason: describe(cause) });
			}
		},
		transformNote:
			'Requests are sent by Whispering’s host, not by this window, with the same API key as transcription. The key is never given to the window or written to the folder.',
		closing: {
			onRequest(listener) {
				closeListeners.add(listener);
				if (closeAsked) {
					closeAsked = false;
					listener();
				}
				return () => closeListeners.delete(listener);
			},
			// An answer that cannot be delivered leaves the window open, which is
			// the safe outcome; closing again asks again.
			async answer(decision) {
				await bridge.app('close', { decision }).catch(() => {});
			},
			// With the host gone there is no bridge. The shell raises this event in
			// the page, and watches for a navigation to the quit address, which it
			// refuses to load and treats as the answer.
			onRequestWithoutHost(listener) {
				hostGoneListeners.add(listener);
				if (closeAskedWithoutHost) {
					closeAskedWithoutHost = false;
					listener();
				}
				return () => hostGoneListeners.delete(listener);
			},
			quitWithoutHost() {
				window.location.assign(`${connection.origin}${QUIT_PATH}`);
			},
		},
		credential: {
			storedIn:
				'this folder’s private .git directory on this device; it is never committed',
			readOnlyReason: info.credentialFromEnvironment
				? 'The key comes from WHISPERING_TRANSCRIPTION_API_KEY.'
				: undefined,
			present: async () =>
				(await bridge.app<HostInfo>('info')).credentialPresent,
			async set(key) {
				try {
					await bridge.app('credential', { key });
					return undefined;
				} catch (cause) {
					return describe(cause);
				}
			},
		},
		// The page is served from a new port on every launch, so its own storage
		// does not last. The host keeps the choice in the device file instead.
		preferences: {
			microphone: async () =>
				(await bridge.app<DevicePreferences>('preferences')).microphone ??
				undefined,
			async setMicrophone(microphone) {
				try {
					await bridge.app('set-preferences', {
						microphone: microphone ?? null,
					});
					return undefined;
				} catch (cause) {
					return describe(cause);
				}
			},
		},
		initialSettings: info.defaults,
		debugControls: info.debug,
		injection: info.debug
			? {
					state: () => bridge.app<InjectionState>('injection'),
					arm: (change) => bridge.app<InjectionState>('inject', change),
					// The host only places and removes the obstacle. A host that cannot
					// be asked places none, and the recording is published all the same.
					async aroundRecordingPublication(recording, publish) {
						const placed = await bridge
							.app<{ obstacle: string | null }>('obstruct', recording)
							.catch(() => undefined);
						try {
							return await publish();
						} finally {
							if (placed?.obstacle != null)
								await bridge
									.app('unobstruct', { obstacle: placed.obstacle })
									.catch(() => {});
						}
					},
				}
			: undefined,
		// Stop hearing the host, then detach from the owner. Detaching commits
		// nothing: saves the owner admitted still land, and it keeps the folder.
		async close() {
			window.removeEventListener(CLOSE_BLOCKED_EVENT, closeBlocked);
			await stopWatching();
			await folder.close();
		},
	});
}

/**
 * The desktop workspace: a real directory, reached through the folder host
 * that serves this page. The terminal is the person's shell in that directory,
 * and transcription requests leave from the host.
 */

import { Ok, type Result } from 'wellcrafted/result';
import { connectFolder, type RemoteFolder } from '../bridge/folder-client.js';
import { type BridgeConnection, createHttpBridge } from '../bridge/http.js';
import {
	type CaptureDevice,
	createFixtureDevice,
	createMicrophoneDevice,
} from '../capture.js';
import { whisperingDefinition } from '../definition.js';
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

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export async function openDesktopWorkspace(
	connection: BridgeConnection,
): Promise<Result<Workspace, WorkspaceError>> {
	const bridge = createHttpBridge(connection);
	// The bridge rejects when the host is unreachable or faults. That is the
	// answer: the page opens no other storage in the host's place.
	let info: HostInfo;
	let remote: RemoteFolder<typeof whisperingDefinition>;
	try {
		info = await bridge.app<HostInfo>('info');
		remote = await connectFolder(whisperingDefinition, bridge.transport);
	} catch (cause) {
		return WorkspaceError.FolderHost({ reason: describe(cause) });
	}

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

	return Ok({
		kind: 'native',
		folder: remote.folder,
		location: info.root,
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
		terminalNote: `${info.shell} in ${info.root}. Each command is a new shell that starts in the directory the last one ended in; there is no interactive terminal device, so full-screen programs do not run.`,
		capture,
		captureNotice: info.fixtureRefused
			? 'WHISPERING_AUDIO_FIXTURE is set, but this build does not allow fixture audio. Recordings use the microphone.'
			: info.fixture?.size === 0
				? `The fixture file ${info.fixture.name} could not be read. Recordings will fail until it can.`
				: undefined,
		onExternalChange: remote.onExternalChange,
		async reveal() {
			try {
				await bridge.app('reveal');
				return undefined;
			} catch (cause) {
				return describe(cause);
			}
		},
		// The bridge rejects when the host is unreachable or faults; a workspace
		// answers with a Result either way.
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
			'Requests are sent by Whispering’s folder host, not by this window, with the same API key as transcription. The key is never given to the window or written to the folder.',
		closing: {
			onRequest: remote.onCloseRequested,
			// An answer that cannot be delivered leaves the window open, which is
			// the safe outcome; closing again asks again.
			async answer(decision) {
				await bridge.app('close', { decision }).catch(() => {});
			},
			// With the host gone there is no bridge. The shell raises this event in
			// the page, and watches for a navigation to the quit address, which it
			// refuses to load and treats as the answer.
			onRequestWithoutHost(listener) {
				window.addEventListener(CLOSE_BLOCKED_EVENT, listener);
				return () => window.removeEventListener(CLOSE_BLOCKED_EVENT, listener);
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
		initialSettings: info.defaults,
		debugControls: info.debug,
		injection: info.debug
			? {
					state: () => bridge.app<InjectionState>('injection'),
					arm: (change) => bridge.app<InjectionState>('inject', change),
				}
			: undefined,
		close: () => remote.close(),
	});
}

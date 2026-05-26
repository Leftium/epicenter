/**
 * Tauri-only capability namespace. Everything that requires the Tauri
 * runtime lives in this file: fs, command, permissions, ffmpeg, tray,
 * globalShortcuts, autostart. The subset that needs TanStack caching,
 * error transformation, or invalidation is exposed in the same shape
 * (no sub-namespace), with each leaf picking one canonical call form.
 *
 * Two files, one import path:
 *
 *     this file                                 → Tauri build
 *     `./tauri.browser.ts` (exports `null`)     → web build
 *
 * Vite picks one at build time via `resolve.extensions` in
 * `vite.config.ts`. TypeScript picks this one for type-checking on both
 * builds via `moduleSuffixes` in `tsconfig.json`, so consumers always
 * see the full `Tauri | null` shape.
 *
 * Two exports, one for each use case:
 *
 *     import { tauri } from '$lib/tauri';
 *     if (tauri) await tauri.fs.pathToBlob(path);
 *     // or
 *     await tauri?.fs.pathToBlob(path);
 *
 *     // Inside *.tauri.ts files only (build guarantees Tauri runtime):
 *     import { requireTauri } from '$lib/tauri';
 *     await requireTauri().fs.pathToBlob(path);
 *
 * `tauri` doubles as the platform check: truthy means we're on Tauri
 * and the whole namespace is available. There is no separate
 * `__TAURI_INTERNALS__` check; the value IS the check.
 *
 * Why the `as Tauri | null` cast on a never-null local: it widens the
 * export type so consumers are forced to narrow.
 *
 * See `specs/20260526T000140-collapse-tauri-only-services-into-namespace.md`.
 */

import { invoke } from '@tauri-apps/api/core';
import { Menu, MenuItem } from '@tauri-apps/api/menu';
import {
	appDataDir,
	basename,
	join,
	resolveResource,
} from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
	disable as disableAutostart,
	enable as enableAutostart,
	isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart';
import { exists, readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import {
	isRegistered as tauriIsRegistered,
	register as tauriRegister,
	unregister as tauriUnregister,
	unregisterAll as tauriUnregisterAll,
} from '@tauri-apps/plugin-global-shortcut';
import { exit } from '@tauri-apps/plugin-process';
import type { Child, ChildProcess } from '@tauri-apps/plugin-shell';
import mime from 'mime';
import { nanoid } from 'nanoid/non-secure';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import type { Command, ShortcutEventState } from '$lib/commands';
import { commandCallbacks } from '$lib/commands';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { getFileExtensionFromFfmpegOptions } from '$lib/constants/ffmpeg';
import { IS_MACOS } from '$lib/constants/platform';
import { defineMutation, defineQuery, queryClient } from '$lib/rpc/client';
import { WhisperingErr } from '$lib/result';
import {
	type Accelerator,
	AcceleratorError,
	type InvalidAcceleratorError,
	isValidElectronAccelerator,
} from '$lib/utils/accelerator';

// fs ----------------------------------------------------------------
export const FsError = defineErrors({
	ReadBlobFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Failed to read file as Blob: ${path}: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
	ReadFileFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `Failed to read file as File: ${path}: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
	ReadFilesFailed: ({ paths, cause }: { paths: string[]; cause: unknown }) => ({
		message: `Failed to read files: ${paths.join(', ')}: ${extractErrorMessage(cause)}`,
		paths,
		cause,
	}),
});
export type FsError = InferErrors<typeof FsError>;

async function readFileWithMimeType(path: string): Promise<{
	bytes: Uint8Array<ArrayBuffer>;
	mimeType: string;
}> {
	// Cast is safe: Tauri's readFile always returns ArrayBuffer-backed Uint8Array.
	const bytes = (await readFile(path)) as Uint8Array<ArrayBuffer>;
	const mimeType = mime.getType(path) ?? 'application/octet-stream';
	return { bytes, mimeType };
}

const fs = {
	pathToBlob: (path: string) =>
		tryAsync({
			try: async () => {
				const { bytes, mimeType } = await readFileWithMimeType(path);
				return new Blob([bytes], { type: mimeType });
			},
			catch: (error) => FsError.ReadBlobFailed({ path, cause: error }),
		}),

	pathToFile: (path: string) =>
		tryAsync({
			try: async () => {
				const { bytes, mimeType } = await readFileWithMimeType(path);
				const fileName = await basename(path);
				return new File([bytes], fileName, { type: mimeType });
			},
			catch: (error) => FsError.ReadFileFailed({ path, cause: error }),
		}),

	pathsToFiles: (paths: string[]) =>
		tryAsync({
			try: () =>
				Promise.all(
					paths.map(async (path) => {
						const { bytes, mimeType } = await readFileWithMimeType(path);
						const fileName = await basename(path);
						return new File([bytes], fileName, { type: mimeType });
					}),
				),
			catch: (error) => FsError.ReadFilesFailed({ paths, cause: error }),
		}),
};

// command -----------------------------------------------------------
export const CommandError = defineErrors({
	ExecuteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to execute command: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SpawnFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to spawn command: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type CommandError = InferErrors<typeof CommandError>;

const command = {
	/**
	 * Execute a command and wait for it to complete.
	 * Commands are parsed and executed directly without shell wrappers on
	 * all platforms; Windows uses CREATE_NO_WINDOW to suppress the console
	 * flash. See https://github.com/EpicenterHQ/epicenter/issues/815.
	 */
	async execute(cmd: string) {
		const { data, error } = await tryAsync({
			try: () =>
				invoke<ChildProcess<string>>('execute_command', { command: cmd }),
			catch: (error) => CommandError.ExecuteFailed({ cause: error }),
		});
		if (error) return Err(error);
		return Ok(data);
	},

	/**
	 * Spawn a child process without waiting for it to complete. Returns a
	 * Child instance that can be used to control the process.
	 */
	async spawn(cmd: string) {
		const { data, error } = await tryAsync({
			try: async () => {
				const pid = await invoke<number>('spawn_command', { command: cmd });
				const { Child } = await import('@tauri-apps/plugin-shell');
				return new Child(pid) as Child;
			},
			catch: (error) => CommandError.SpawnFailed({ cause: error }),
		});
		if (error) return Err(error);
		return Ok(data);
	},
};

// permissions -------------------------------------------------------
export const PermissionsError = defineErrors({
	CheckAccessibility: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check accessibility permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestAccessibility: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request accessibility permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CheckMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
	RequestMicrophone: ({ cause }: { cause: unknown }) => ({
		message: `Failed to request microphone permissions: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type PermissionsError = InferErrors<typeof PermissionsError>;

const permissions = {
	accessibility: {
		async check() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { checkAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await checkAccessibilityPermission();
				},
				catch: (error) => PermissionsError.CheckAccessibility({ cause: error }),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { requestAccessibilityPermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await requestAccessibilityPermission();
				},
				catch: (error) =>
					PermissionsError.RequestAccessibility({ cause: error }),
			});
		},
	},

	microphone: {
		async check() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { checkMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await checkMicrophonePermission();
				},
				catch: (error) => PermissionsError.CheckMicrophone({ cause: error }),
			});
		},

		async request() {
			if (!IS_MACOS) return Ok(true);
			return tryAsync({
				try: async () => {
					const { requestMicrophonePermission } = await import(
						'tauri-plugin-macos-permissions-api'
					);
					return await requestMicrophonePermission();
				},
				catch: (error) => PermissionsError.RequestMicrophone({ cause: error }),
			});
		},
	},
};

// ffmpeg ------------------------------------------------------------
export const FfmpegError = defineErrors({
	InstallCheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check FFmpeg installation: ${extractErrorMessage(cause)}`,
		cause,
	}),
	VerifyFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to verify temp file accessibility: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CompressFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to compress audio: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type FfmpegError = InferErrors<typeof FfmpegError>;

function buildCompressionCommand({
	inputPath,
	compressionOptions,
	outputPath,
}: {
	inputPath: string;
	compressionOptions: string;
	outputPath: string;
}) {
	return [
		'ffmpeg',
		'-i',
		`"${inputPath}"`,
		compressionOptions.trim(),
		`"${outputPath}"`,
	]
		.filter((part) => part)
		.join(' ');
}

// `_ffmpegCheckInstalled` is the raw implementation; the public
// `tauri.ffmpeg.checkInstalled` below is the TanStack-wrapped form.
const _ffmpegCheckInstalled = async () => {
	const { data: result, error } = await tryAsync({
		try: async () => {
			const { data, error: commandError } =
				await command.execute('ffmpeg -version');
			if (commandError) throw commandError;
			return data;
		},
		catch: (error) => FfmpegError.InstallCheckFailed({ cause: error }),
	});
	if (error) return Err(error);
	return Ok(result.code === 0);
};

/**
 * Compress an audio blob using FFmpeg. Creates temp files for the
 * input/output and cleans them up on completion (success or failure).
 */
const compressAudioBlob = (blob: Blob, compressionOptions: string) =>
	tryAsync({
		try: async () => {
			const sessionId = nanoid();
			const tempDir = await appDataDir();
			const inputPath = await join(
				tempDir,
				`compression_input_${sessionId}.wav`,
			);
			const outputExtension =
				getFileExtensionFromFfmpegOptions(compressionOptions);
			const outputPath = await join(
				tempDir,
				`compression_output_${sessionId}.${outputExtension}`,
			);

			try {
				const inputContents = new Uint8Array(await blob.arrayBuffer());
				await writeFile(inputPath, inputContents);

				// Verify file is accessible (forces OS flush on Windows).
				const { error: verifyError } = await tryAsync({
					try: () => fs.pathToBlob(inputPath),
					catch: (error) => FfmpegError.VerifyFailed({ cause: error }),
				});
				if (verifyError) throw new Error(verifyError.message);

				const cmd = buildCompressionCommand({
					inputPath,
					compressionOptions,
					outputPath,
				});
				const { data: result, error: commandError } =
					await command.execute(cmd);
				if (commandError) {
					throw new Error(
						`FFmpeg compression failed: ${commandError.message}`,
					);
				}
				if (result.code !== 0) {
					throw new Error(
						`FFmpeg compression failed with exit code ${result.code}: ${result.stderr}`,
					);
				}

				const outputExists = await exists(outputPath);
				if (!outputExists) {
					throw new Error(
						'FFmpeg compression completed but output file was not created',
					);
				}

				const { data: compressedBlob, error: readError } =
					await fs.pathToBlob(outputPath);
				if (readError) {
					throw new Error(
						`Failed to read compressed audio file: ${readError.message}`,
					);
				}
				return compressedBlob;
			} finally {
				await tryAsync({
					try: async () => {
						if (await exists(inputPath)) await remove(inputPath);
						if (await exists(outputPath)) await remove(outputPath);
					},
					catch: () => Ok(undefined),
				});
			}
		},
		catch: (error) => FfmpegError.CompressFailed({ cause: error }),
	});

// tray --------------------------------------------------------------
export const TrayError = defineErrors({
	SetIcon: ({ cause }: { cause: unknown }) => ({
		message: `Failed to set tray icon: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type TrayError = InferErrors<typeof TrayError>;

const TRAY_ID = 'whispering-tray';
let trayPromise: ReturnType<typeof initTray> | null = null;

async function getIconPath(recorderState: WhisperingRecordingState) {
	const iconPaths = {
		IDLE: 'recorder-state-icons/studio_microphone.png',
		RECORDING: 'recorder-state-icons/red_large_square.png',
	} as const satisfies Record<WhisperingRecordingState, string>;
	return resolveResource(iconPaths[recorderState]);
}

async function initTray() {
	const existing = await TrayIcon.getById(TRAY_ID);
	if (existing) return existing;

	const trayMenu = await Menu.new({
		items: [
			await MenuItem.new({
				id: 'show',
				text: 'Show Window',
				action: () => getCurrentWindow().show(),
			}),
			await MenuItem.new({
				id: 'hide',
				text: 'Hide Window',
				action: () => getCurrentWindow().hide(),
			}),
			await MenuItem.new({
				id: 'settings',
				text: 'Settings',
				action: () => {
					goto('/settings');
					return getCurrentWindow().show();
				},
			}),
			await MenuItem.new({
				id: 'quit',
				text: 'Quit',
				action: () => void exit(0),
			}),
		],
	});

	return TrayIcon.new({
		id: TRAY_ID,
		icon: await getIconPath('IDLE'),
		menu: trayMenu,
		menuOnLeftClick: false,
		action: (e) => {
			if (
				e.type === 'Click' &&
				e.button === 'Left' &&
				e.buttonState === 'Down'
			) {
				return true;
			}
			return false;
		},
	});
}

// Raw tray ops; the public `tauri.tray.setIcon` below is the
// TanStack-wrapped form.
const _traySetIcon = (recorderState: WhisperingRecordingState) =>
	tryAsync({
		try: async () => {
			const iconPath = await getIconPath(recorderState);
			if (!trayPromise) trayPromise = initTray();
			const t = await trayPromise;
			return t.setIcon(iconPath);
		},
		catch: (error) => TrayError.SetIcon({ cause: error }),
	});

// globalShortcuts ---------------------------------------------------
// Pure accelerator parsing/validation lives in `$lib/utils/accelerator`
// since it has no Tauri runtime dependency. Only the registration ops
// (which talk to Tauri's global-shortcut plugin) live here.
export const ShortcutError = defineErrors({
	RegisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to register global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterFailed: ({
		accelerator,
		cause,
	}: {
		accelerator: string;
		cause: unknown;
	}) => ({
		message: `Failed to unregister global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterAllFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to unregister all global shortcuts: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ShortcutError = InferErrors<typeof ShortcutError>;
type GlobalShortcutServiceError =
	| InferError<typeof ShortcutError.RegisterFailed>
	| InferError<typeof ShortcutError.UnregisterFailed>
	| InferError<typeof ShortcutError.UnregisterAllFailed>;

// Raw globalShortcuts ops; public `tauri.globalShortcuts` below
// exposes TanStack-wrapped versions of register/unregister/unregisterAll
// (named registerCommand/unregisterCommand/unregisterAll).

async function _registerShortcut({
	accelerator,
	callback,
	on,
}: {
	accelerator: Accelerator;
	callback: (state: ShortcutEventState) => void;
	on: ShortcutEventState[];
}): Promise<
	Result<void, InvalidAcceleratorError | GlobalShortcutServiceError>
> {
	const { error: unregisterError } = await _unregisterShortcut(accelerator);
	if (unregisterError) return Err(unregisterError);

	if (!isValidElectronAccelerator(accelerator)) {
		return AcceleratorError.InvalidFormat({ accelerator });
	}

	const { error: registerError } = await tryAsync({
		try: () =>
			tauriRegister(accelerator, (event) => {
				if (on.includes(event.state)) callback(event.state);
			}),
		catch: (error) =>
			ShortcutError.RegisterFailed({ accelerator, cause: error }),
	});
	// Tauri's platform layer sometimes returns "RegisterEventHotKey failed"
	// even after a successful registration. We swallow that error to avoid
	// an unhelpful toast; other valid shortcuts still register.
	if (registerError) return Ok(undefined);
	return Ok(undefined);
}

async function _unregisterShortcut(
	accelerator: Accelerator,
): Promise<Result<void, GlobalShortcutServiceError>> {
	const isRegistered = await tauriIsRegistered(accelerator);
	if (!isRegistered) return Ok(undefined);

	const { error } = await tryAsync({
		try: () => tauriUnregister(accelerator),
		catch: (error) =>
			ShortcutError.UnregisterFailed({ accelerator, cause: error }),
	});
	if (error) return Err(error);
	return Ok(undefined);
}

async function _unregisterAllShortcuts(): Promise<
	Result<void, GlobalShortcutServiceError>
> {
	const { error } = await tryAsync({
		try: () => tauriUnregisterAll(),
		catch: (error) => ShortcutError.UnregisterAllFailed({ cause: error }),
	});
	if (error) return Err(error);
	return Ok(undefined);
}

// autostart ---------------------------------------------------------
export const AutostartError = defineErrors({
	CheckFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to check autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	EnableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
	DisableFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to disable autostart: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AutostartError = InferErrors<typeof AutostartError>;

// Raw autostart ops; public TanStack-wrapped versions are defined below.
const _autostartIsEnabled = () =>
	tryAsync({
		try: () => isAutostartEnabled(),
		catch: (error) => AutostartError.CheckFailed({ cause: error }),
	});
const _autostartEnable = () =>
	tryAsync({
		try: () => enableAutostart(),
		catch: (error) => AutostartError.EnableFailed({ cause: error }),
	});
const _autostartDisable = () =>
	tryAsync({
		try: () => disableAutostart(),
		catch: (error) => AutostartError.DisableFailed({ cause: error }),
	});

// Public namespaces ------------------------------------------------
// Each capability picks ONE shape per method: TanStack-wrapped where
// reactivity/caching is the point, raw async functions where it isn't.
// One canonical call shape per leaf; no `tauri.X.Y` vs `tauri.rpc.X.Y`
// duplication.

const autostartKeys = {
	isEnabled: ['autostart', 'isEnabled'] as const,
	enable: ['autostart', 'enable'] as const,
	disable: ['autostart', 'disable'] as const,
};
const invalidateAutostartState = () =>
	queryClient.invalidateQueries({ queryKey: autostartKeys.isEnabled });

const autostart = {
	isEnabled: defineQuery({
		queryKey: autostartKeys.isEnabled,
		queryFn: async () => {
			const { data, error } = await _autostartIsEnabled();
			if (error) {
				return WhisperingErr({
					title: '❌ Failed to check autostart status',
					serviceError: error,
				});
			}
			return Ok(data);
		},
		initialData: false,
	}),
	enable: defineMutation({
		mutationKey: autostartKeys.enable,
		mutationFn: async () => {
			const { data, error } = await _autostartEnable();
			if (error) {
				return WhisperingErr({
					title: '❌ Failed to enable autostart',
					serviceError: error,
				});
			}
			return Ok(data);
		},
		onSettled: invalidateAutostartState,
	}),
	disable: defineMutation({
		mutationKey: autostartKeys.disable,
		mutationFn: async () => {
			const { data, error } = await _autostartDisable();
			if (error) {
				return WhisperingErr({
					title: '❌ Failed to disable autostart',
					serviceError: error,
				});
			}
			return Ok(data);
		},
		onSettled: invalidateAutostartState,
	}),
};

const ffmpeg = {
	checkInstalled: defineQuery({
		queryKey: ['ffmpeg.checkInstalled'] as const,
		queryFn: async () => {
			const { data, error } = await _ffmpegCheckInstalled();
			if (error) {
				return WhisperingErr({
					title: '❌ Error checking FFmpeg installation',
					serviceError: error,
				});
			}
			return Ok(data);
		},
	}),
	compressAudioBlob,
};

const tray = {
	setIcon: defineMutation({
		mutationKey: ['tray', 'setIcon'] as const,
		mutationFn: async ({ icon }: { icon: WhisperingRecordingState }) => {
			const { data, error } = await _traySetIcon(icon);
			if (error) {
				return WhisperingErr({
					title: '⚠️ Failed to set tray icon',
					serviceError: error,
				});
			}
			return Ok(data);
		},
	}),
};

const globalShortcuts = {
	registerCommand: defineMutation({
		mutationKey: ['shortcuts', 'registerCommandGlobally'] as const,
		mutationFn: ({
			command: cmd,
			// Parameter may contain legacy "CommandOrControl" syntax.
			// Legacy: "CommandOrControl+Shift+R" → Modern: "Command+Shift+R"
			// (macOS) or "Control+Shift+R" (Windows/Linux).
			accelerator: legacyAcceleratorString,
		}: {
			command: Command;
			accelerator: Accelerator;
		}) => {
			const accel = legacyAcceleratorString.replace(
				'CommandOrControl',
				IS_MACOS ? 'Command' : 'Control',
			) as Accelerator;
			return _registerShortcut({
				accelerator: accel,
				callback: commandCallbacks[cmd.id],
				on: cmd.on,
			});
		},
	}),

	unregisterCommand: defineMutation({
		mutationKey: ['shortcuts', 'unregisterCommandGlobally'] as const,
		mutationFn: ({ accelerator }: { accelerator: Accelerator }) =>
			_unregisterShortcut(accelerator),
	}),

	unregisterAll: defineMutation({
		mutationKey: ['shortcuts', 'unregisterAllGlobalShortcuts'] as const,
		mutationFn: () => _unregisterAllShortcuts(),
	}),
};

// barrel ------------------------------------------------------------
// Local `tauriImpl` holds the non-null namespace on Tauri builds. The
// `tauri` export widens it to `Tauri | null` so consumers narrow;
// `requireTauri()` returns the asserted form for `.tauri.ts` callers.
const tauriImpl = {
	fs,
	command,
	permissions,
	ffmpeg,
	tray,
	globalShortcuts,
	autostart,
};

/** Shape of the Tauri capability namespace (non-null). */
export type Tauri = typeof tauriImpl;

/**
 * The Tauri capability namespace, or `null` on web builds.
 * Doubles as the platform check: truthy means Tauri.
 */
export const tauri: Tauri | null = tauriImpl;

/**
 * Returns the Tauri namespace, asserting we're on Tauri.
 *
 * Use ONLY inside `*.tauri.ts` files where the build system guarantees
 * this module loads only on Tauri. Throws on web, which should be
 * unreachable given the suffix routing.
 */
export function requireTauri(): Tauri {
	if (!tauri) {
		throw new Error('requireTauri() called outside Tauri runtime');
	}
	return tauri;
}

/**
 * Tauri-only capability namespace.
 *
 * This file replaces the per-capability `services/<cap>/index.tauri.ts +
 * index.browser.ts` pairs for the seven Tauri-only services. The browser
 * companion is a single one-line `tauri.browser.ts` that exports `null`;
 * the optional chain at consumer sites is the platform gate.
 *
 * See `specs/20260526T000140-collapse-tauri-only-services-into-namespace.md`
 * for the rationale, migration plan, and the test for which DI pattern fits
 * which kind of dependency.
 *
 * Consumer pattern:
 *
 *     import tauri from '$lib/tauri';
 *     await tauri?.fs.pathToBlob(path);
 *
 * The cast `as typeof tauri | null` at the bottom is the only piece of
 * type ceremony in the file. It forces consumers to narrow before access,
 * which gives us the runtime gate for free without scattering
 * `window.__TAURI_INTERNALS__` checks across call sites.
 */

import { invoke } from '@tauri-apps/api/core';
import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { appDataDir, basename, join, resolveResource } from '@tauri-apps/api/path';
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
import * as os from '@tauri-apps/plugin-os';
import { exit } from '@tauri-apps/plugin-process';
import type { Child, ChildProcess } from '@tauri-apps/plugin-shell';
import mime from 'mime';
import { nanoid } from 'nanoid/non-secure';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { getFileExtensionFromFfmpegOptions } from '$lib/constants/ffmpeg';
import {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_MODIFIER_SORT_PRIORITY,
	ACCELERATOR_PUNCTUATION_KEYS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
	FUNCTION_KEY_PATTERN,
	KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';
import { IS_MACOS } from '$lib/constants/platform';
import type { ShortcutEventState } from '$lib/commands';

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
			try: () => invoke<ChildProcess<string>>('execute_command', { command: cmd }),
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
				catch: (error) =>
					PermissionsError.RequestMicrophone({ cause: error }),
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

const ffmpeg = {
	/** Returns Ok(true) if FFmpeg is installed, Ok(false) otherwise. */
	async checkInstalled() {
		const { data: result, error } = await tryAsync({
			try: async () => {
				const { data, error: commandError } = await command.execute('ffmpeg -version');
				if (commandError) throw commandError;
				return data;
			},
			catch: (error) => FfmpegError.InstallCheckFailed({ cause: error }),
		});
		if (error) return Err(error);
		return Ok(result.code === 0);
	},

	/**
	 * Compress an audio blob using FFmpeg. Creates temp files for the
	 * input/output and cleans them up on completion (success or failure).
	 */
	async compressAudioBlob(blob: Blob, compressionOptions: string) {
		return tryAsync({
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
						throw new Error(`FFmpeg compression failed: ${commandError.message}`);
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
	},
};

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

const tray = {
	setIcon: (recorderState: WhisperingRecordingState) =>
		tryAsync({
			try: async () => {
				const iconPath = await getIconPath(recorderState);
				if (!trayPromise) trayPromise = initTray();
				const t = await trayPromise;
				return t.setIcon(iconPath);
			},
			catch: (error) => TrayError.SetIcon({ cause: error }),
		}),
};

// globalShortcuts ---------------------------------------------------
export const ShortcutError = defineErrors({
	InvalidFormat: ({ accelerator }: { accelerator: string }) => ({
		message: `Invalid accelerator format: '${accelerator}'. Must follow Electron accelerator specification.`,
		accelerator,
	}),
	NoKeyCode: () => ({
		message: 'No valid key code found in pressed keys',
	}),
	MultipleKeyCodes: () => ({
		message: 'Multiple key codes not allowed in accelerator',
	}),
	GeneratedInvalid: ({ accelerator }: { accelerator: string }) => ({
		message: `Generated invalid accelerator: ${accelerator}`,
		accelerator,
	}),
	RegisterFailed: ({ accelerator, cause }: { accelerator: string; cause: unknown }) => ({
		message: `Failed to register global shortcut '${accelerator}': ${extractErrorMessage(cause)}`,
		accelerator,
		cause,
	}),
	UnregisterFailed: ({ accelerator, cause }: { accelerator: string; cause: unknown }) => ({
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
type InvalidAcceleratorError =
	| InferError<typeof ShortcutError.InvalidFormat>
	| InferError<typeof ShortcutError.NoKeyCode>
	| InferError<typeof ShortcutError.MultipleKeyCodes>
	| InferError<typeof ShortcutError.GeneratedInvalid>;
type GlobalShortcutServiceError =
	| InferError<typeof ShortcutError.RegisterFailed>
	| InferError<typeof ShortcutError.UnregisterFailed>
	| InferError<typeof ShortcutError.UnregisterAllFailed>;

/**
 * Brand for Electron accelerator strings.
 *
 * @example 'CommandOrControl+P'
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
export type Accelerator = string & Brand<'Accelerator'>;

function isValidElectronAccelerator(accelerator: string): boolean {
	const parts = accelerator.split('+');
	if (parts.length === 0) return false;
	const modifiers = parts.slice(0, -1);
	const lastPart = parts.at(-1);
	if (!ACCELERATOR_KEY_CODES.includes(lastPart as AcceleratorKeyCode)) return false;
	for (const modifier of modifiers) {
		if (!ACCELERATOR_MODIFIER_KEYS.includes(modifier as AcceleratorModifier))
			return false;
	}
	if (new Set(modifiers).size !== modifiers.length) return false;
	return true;
}

function convertToModifier(
	key: KeyboardEventSupportedKey,
): AcceleratorModifier | null {
	const platform = os.type();
	switch (key) {
		case 'control':
			return 'Control';
		case 'shift':
			return 'Shift';
		case 'alt':
			return platform === 'macos' ? 'Option' : 'Alt';
		case 'meta':
			return platform === 'macos' ? 'Command' : 'Super';
		case 'altgraph':
			return platform === 'macos' ? null : 'AltGr';
		case 'super':
			return 'Super';
		case 'fn':
			return null;
		default:
			return null;
	}
}

function convertToKeyCode(
	key: KeyboardEventSupportedKey,
): AcceleratorKeyCode | null {
	if (key.length === 1 && key >= 'a' && key <= 'z') {
		return key.toUpperCase() as AcceleratorKeyCode;
	}
	if (key.length === 1 && key >= '0' && key <= '9') {
		return key as AcceleratorKeyCode;
	}
	if (FUNCTION_KEY_PATTERN.test(key)) {
		return key.toUpperCase() as AcceleratorKeyCode;
	}
	const mappedKey = KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP[key];
	if (mappedKey) return mappedKey;
	if (
		ACCELERATOR_PUNCTUATION_KEYS.includes(
			key as (typeof ACCELERATOR_PUNCTUATION_KEYS)[number],
		)
	) {
		return key as AcceleratorKeyCode;
	}
	return null;
}

function sortModifiers(modifiers: AcceleratorModifier[]): AcceleratorModifier[] {
	return [...modifiers].sort((a, b) => {
		const priorityA = ACCELERATOR_MODIFIER_SORT_PRIORITY[a] ?? 99;
		const priorityB = ACCELERATOR_MODIFIER_SORT_PRIORITY[b] ?? 99;
		return priorityA - priorityB;
	});
}

const globalShortcuts = {
	async register({
		accelerator,
		callback,
		on,
	}: {
		accelerator: Accelerator;
		callback: (state: ShortcutEventState) => void;
		on: ShortcutEventState[];
	}): Promise<Result<void, InvalidAcceleratorError | GlobalShortcutServiceError>> {
		const { error: unregisterError } =
			await globalShortcuts.unregister(accelerator);
		if (unregisterError) return Err(unregisterError);

		if (!isValidElectronAccelerator(accelerator)) {
			return ShortcutError.InvalidFormat({ accelerator });
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
	},

	async unregister(
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
	},

	async unregisterAll(): Promise<Result<void, GlobalShortcutServiceError>> {
		const { error } = await tryAsync({
			try: () => tauriUnregisterAll(),
			catch: (error) => ShortcutError.UnregisterAllFailed({ cause: error }),
		});
		if (error) return Err(error);
		return Ok(undefined);
	},

	isValidElectronAccelerator,

	pressedKeysToTauriAccelerator(
		pressedKeys: KeyboardEventSupportedKey[],
	): Result<Accelerator, InvalidAcceleratorError> {
		const modifiers: AcceleratorModifier[] = [];
		const keyCodes: AcceleratorKeyCode[] = [];

		for (const key of pressedKeys) {
			const modifier = convertToModifier(key);
			if (modifier) {
				modifiers.push(modifier);
				continue;
			}
			const keyCode = convertToKeyCode(key);
			if (keyCode) keyCodes.push(keyCode);
		}

		if (keyCodes.length === 0) return ShortcutError.NoKeyCode();
		if (keyCodes.length > 1) return ShortcutError.MultipleKeyCodes();

		const sortedModifiers = sortModifiers(modifiers);
		const accelerator = [...sortedModifiers, keyCodes.at(0)].join(
			'+',
		) as Accelerator;

		if (!isValidElectronAccelerator(accelerator)) {
			return ShortcutError.GeneratedInvalid({ accelerator });
		}
		return Ok(accelerator);
	},
};

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

const autostart = {
	isEnabled: () =>
		tryAsync({
			try: () => isAutostartEnabled(),
			catch: (error) => AutostartError.CheckFailed({ cause: error }),
		}),
	enable: () =>
		tryAsync({
			try: () => enableAutostart(),
			catch: (error) => AutostartError.EnableFailed({ cause: error }),
		}),
	disable: () =>
		tryAsync({
			try: () => disableAutostart(),
			catch: (error) => AutostartError.DisableFailed({ cause: error }),
		}),
};

// barrel ------------------------------------------------------------
const tauri = {
	fs,
	command,
	permissions,
	ffmpeg,
	tray,
	globalShortcuts,
	autostart,
};

export default tauri as typeof tauri | null;

/**
 * Electron-style accelerator parsing and validation. Pure helpers with
 * no Tauri or DOM dependencies; safe to import from any platform.
 *
 * Tauri's global-shortcut plugin happens to accept the same accelerator
 * format Electron uses, which is why the runtime registration code in
 * `$lib/tauri.tauri.ts` consumes these. The format itself isn't
 * Tauri-specific.
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */

import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { os } from '#platform/os';
import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
import {
	ACCELERATOR_KEY_CODES,
	ACCELERATOR_MODIFIER_KEYS,
	ACCELERATOR_PUNCTUATION_KEYS,
	type AcceleratorKeyCode,
	type AcceleratorModifier,
	FUNCTION_KEY_PATTERN,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';

/**
 * Maps browser KeyboardEvent.key values (lowercased) to Electron/Tauri
 * accelerator key codes. Handles "special" keys only (arrows, whitespace,
 * media keys); letters, numbers, F-keys, and punctuation are handled in
 * convertToKeyCode below.
 */
const KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP = {
	// Arrow keys
	arrowup: 'Up',
	arrowdown: 'Down',
	arrowleft: 'Left',
	arrowright: 'Right',

	// Whitespace
	' ': 'Space',
	enter: 'Enter',
	tab: 'Tab',

	// Special keys
	escape: 'Escape',
	backspace: 'Backspace',
	delete: 'Delete',
	insert: 'Insert',
	home: 'Home',
	end: 'End',
	pageup: 'PageUp',
	pagedown: 'PageDown',
	printscreen: 'PrintScreen',

	// Media keys
	volumeup: 'VolumeUp',
	volumedown: 'VolumeDown',
	volumemute: 'VolumeMute',
	mediaplaypause: 'MediaPlayPause',
	mediastop: 'MediaStop',
	mediatracknext: 'MediaNextTrack',
	mediatrackprevious: 'MediaPreviousTrack',

	// Lock keys (when used as regular keys, not modifiers)
	capslock: 'Capslock',
	numlock: 'Numlock',
	scrolllock: 'Scrolllock',
} as const satisfies Partial<Record<string, AcceleratorKeyCode>>;

/**
 * Sort priority for accelerator modifiers (lower appears first):
 * Command/Control, then Alt/Option, then AltGr, then Shift, then Super/Meta.
 */
const ACCELERATOR_MODIFIER_SORT_PRIORITY = {
	Command: 1,
	Cmd: 1,
	Control: 1,
	Ctrl: 1,
	Alt: 2,
	Option: 2,
	AltGr: 3,
	Shift: 4,
	Super: 5,
	Meta: 5,
} as const satisfies Record<AcceleratorModifier, number>;

/**
 * Brand for Electron accelerator strings.
 *
 * @example 'CommandOrControl+P'
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
export type Accelerator = string & Brand<'Accelerator'>;

export const AcceleratorError = defineErrors({
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
});
export type AcceleratorError = InferErrors<typeof AcceleratorError>;

export type InvalidAcceleratorError =
	| InferError<typeof AcceleratorError.InvalidFormat>
	| InferError<typeof AcceleratorError.NoKeyCode>
	| InferError<typeof AcceleratorError.MultipleKeyCodes>
	| InferError<typeof AcceleratorError.GeneratedInvalid>;

export function isValidElectronAccelerator(accelerator: string): boolean {
	const parts = accelerator.split('+');
	if (parts.length === 0) return false;
	const modifiers = parts.slice(0, -1);
	const lastPart = parts.at(-1);
	if (!ACCELERATOR_KEY_CODES.includes(lastPart as AcceleratorKeyCode))
		return false;
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
	switch (key) {
		case 'control':
			return 'Control';
		case 'shift':
			return 'Shift';
		case 'alt':
			return os.isApple ? 'Option' : 'Alt';
		case 'meta':
			return os.isApple ? 'Command' : 'Super';
		case 'altgraph':
			return os.isApple ? null : 'AltGr';
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
	const mappedKey =
		key in KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP
			? KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP[
					key as keyof typeof KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP
				]
			: null;
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

function sortModifiers(
	modifiers: AcceleratorModifier[],
): AcceleratorModifier[] {
	return [...modifiers].sort((a, b) => {
		const priorityA = ACCELERATOR_MODIFIER_SORT_PRIORITY[a] ?? 99;
		const priorityB = ACCELERATOR_MODIFIER_SORT_PRIORITY[b] ?? 99;
		return priorityA - priorityB;
	});
}

/**
 * Maps an Electron accelerator modifier token to an rdev `Modifier`. Collapses
 * left/right and folds AltGr into Alt (the v1 simplification). Resolves the
 * legacy `CommandOrControl` / `CommandOrAlt` tokens against the platform.
 */
function acceleratorModifierToRdev(token: string): Modifier | null {
	switch (token) {
		case 'Command':
		case 'Cmd':
		case 'Super':
		case 'Meta':
			return 'meta';
		case 'Control':
		case 'Ctrl':
			return 'ctrl';
		case 'Alt':
		case 'Option':
		case 'AltGr':
			return 'alt';
		case 'Shift':
			return 'shift';
		case 'CommandOrControl':
			return os.isApple ? 'meta' : 'ctrl';
		case 'CommandOrAlt':
			return os.isApple ? 'meta' : 'alt';
		default:
			return null;
	}
}

/**
 * Maps an Electron accelerator key code (the final token) to an rdev physical
 * `Key` name. Letters/digits/F-keys map by shape; named and punctuation keys
 * map by table. Returns null for anything not expressible as an rdev key.
 */
const ACCELERATOR_KEY_CODE_TO_RDEV_KEY = {
	Up: 'upArrow',
	Down: 'downArrow',
	Left: 'leftArrow',
	Right: 'rightArrow',
	Space: 'space',
	Enter: 'return',
	Tab: 'tab',
	Escape: 'escape',
	Backspace: 'backspace',
	Delete: 'delete',
	Insert: 'insert',
	Home: 'home',
	End: 'end',
	PageUp: 'pageUp',
	PageDown: 'pageDown',
	';': 'semiColon',
	"'": 'quote',
	',': 'comma',
	'.': 'dot',
	'/': 'slash',
	'-': 'minus',
	'=': 'equal',
	'[': 'leftBracket',
	']': 'rightBracket',
	'\\': 'backSlash',
	'`': 'backQuote',
} as const satisfies Record<string, Key>;

function acceleratorKeyCodeToRdev(token: string): Key | null {
	if (token.length === 1 && token >= 'A' && token <= 'Z') {
		return `key${token}` as Key;
	}
	if (token.length === 1 && token >= '0' && token <= '9') {
		return `num${token}` as Key;
	}
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(token)) {
		return token.toLowerCase() as Key;
	}
	if (token in ACCELERATOR_KEY_CODE_TO_RDEV_KEY) {
		return ACCELERATOR_KEY_CODE_TO_RDEV_KEY[
			token as keyof typeof ACCELERATOR_KEY_CODE_TO_RDEV_KEY
		];
	}
	return null;
}

/**
 * Parses a stored Electron accelerator string (for example `Command+Shift+D`)
 * into the structured `KeyBinding` the rdev backend matches on. Used both at
 * the desktop sync boundary (Wave 3, storage still holds accelerator strings)
 * and by the one-time device-config migration (Wave 4). Returns null when any
 * token is not expressible as an rdev key/modifier, in which case the caller
 * resets to the default. Accelerators always carry exactly one key code, so the
 * result has exactly one key; Fn and modifier-only bindings are not expressible
 * as accelerators and only come from the new recorder.
 */
export function acceleratorToKeyBinding(
	accelerator: string,
): KeyBinding | null {
	const parts = accelerator.split('+');
	const keyToken = parts.at(-1);
	if (!keyToken) return null;

	const modifiers: Modifier[] = [];
	for (const token of parts.slice(0, -1)) {
		const modifier = acceleratorModifierToRdev(token);
		if (!modifier) return null;
		modifiers.push(modifier);
	}

	const key = acceleratorKeyCodeToRdev(keyToken);
	if (!key) return null;

	return { modifiers, keys: [key] };
}

export function pressedKeysToAccelerator(
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

	if (keyCodes.length === 0) return AcceleratorError.NoKeyCode();
	if (keyCodes.length > 1) return AcceleratorError.MultipleKeyCodes();

	const sortedModifiers = sortModifiers(modifiers);
	const accelerator = [...sortedModifiers, keyCodes.at(0)].join(
		'+',
	) as Accelerator;

	if (!isValidElectronAccelerator(accelerator)) {
		return AcceleratorError.GeneratedInvalid({ accelerator });
	}
	return Ok(accelerator);
}

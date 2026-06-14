/**
 * Parses the legacy Electron-style accelerator strings that global shortcuts
 * used to be stored as (for example `Command+Shift+D`) into the structured
 * `KeyBinding` the rdev backend now matches on. The only consumer is the
 * one-time device-config migration; nothing writes accelerators anymore.
 */

import { os } from '#platform/os';
import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';

/**
 * Maps an accelerator modifier token to an rdev `Modifier`. Collapses left/right
 * and folds AltGr into Alt (the v1 simplification). Resolves the legacy
 * `CommandOrControl` / `CommandOrAlt` tokens against the platform.
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

/**
 * Maps an accelerator key code (the final token) to an rdev physical `Key`.
 * Letters/digits/F-keys map by shape; named and punctuation keys map by table.
 * Returns null for anything not expressible as an rdev key.
 */
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
 * Parses a stored accelerator string into a `KeyBinding`, or null when any token
 * is not expressible as an rdev key/modifier (the migration resets those to the
 * default). Accelerators always carry exactly one key code, so the result has
 * exactly one key; Fn and modifier-only bindings were never expressible as
 * accelerators and only come from the new recorder.
 */
export function acceleratorToKeyBinding(accelerator: string): KeyBinding | null {
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

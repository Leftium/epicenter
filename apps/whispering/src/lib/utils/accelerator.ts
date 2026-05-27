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
			return IS_MACOS ? 'Option' : 'Alt';
		case 'meta':
			return IS_MACOS ? 'Command' : 'Super';
		case 'altgraph':
			return IS_MACOS ? null : 'AltGr';
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

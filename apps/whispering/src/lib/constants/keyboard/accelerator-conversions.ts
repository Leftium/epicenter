import type {
	AcceleratorKeyCode,
	AcceleratorModifier,
} from './accelerator/supported-keys';

/**
 * Maps browser KeyboardEvent.key values (lowercased) to Electron/Tauri Accelerator key codes.
 *
 * This map handles "special" keys only (arrows, whitespace, media keys, etc.).
 * Letters, numbers, F-keys, and punctuation are handled separately in conversion logic.
 *
 * @example
 * ```typescript
 * const acceleratorKey = KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP['arrowup'];
 * // Returns 'Up'
 * ```
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
export const KEYBOARD_EVENT_SPECIAL_KEY_TO_ACCELERATOR_KEY_CODE_MAP: Partial<
	Record<string, AcceleratorKeyCode>
> = {
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
} as const;

/**
 * Defines the standard sort priority for accelerator modifiers.
 * Lower numbers appear first in the accelerator string.
 *
 * Standard order: Command/Control → Alt/Option → AltGr → Shift → Super/Meta
 *
 * @example
 * ```typescript
 * modifiers.sort((a, b) =>
 *   (ACCELERATOR_MODIFIER_SORT_PRIORITY[a] ?? 99) -
 *   (ACCELERATOR_MODIFIER_SORT_PRIORITY[b] ?? 99)
 * );
 * ```
 */
export const ACCELERATOR_MODIFIER_SORT_PRIORITY: Record<
	AcceleratorModifier,
	number
> = {
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
} as const;

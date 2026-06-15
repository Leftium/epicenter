import { on } from 'svelte/events';
import type { Brand } from 'wellcrafted/brand';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { os } from '#platform/os';
import type { ShortcutEventState } from '$lib/commands';
import {
	type KeyboardEventPossibleKey,
	type KeyboardEventSupportedKey,
} from '$lib/constants/keyboard';
import {
	isSupportedKey,
	normalizeOptionKeyCharacter,
} from '$lib/utils/keyboard';

const LocalShortcutError = defineErrors({
	RegisterFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to register local shortcut: ${extractErrorMessage(cause)}`,
		cause,
	}),
	UnregisterFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to unregister local shortcut: ${extractErrorMessage(cause)}`,
		cause,
	}),
	UnregisterAllFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to unregister all local shortcuts: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type LocalShortcutError = InferErrors<typeof LocalShortcutError>;

export type CommandId = string & Brand<'CommandId'>;

/**
 * Registered combos by command id. The manager only matches physical keys and
 * tracks press/release edges; it does not own which edges a command cares about
 * (the `on` filter) or what the command does (the callback). Both live in the
 * command layer, reached through the `onTrigger` sink passed to `listen`.
 */
const shortcuts = new Map<CommandId, KeyboardEventSupportedKey[]>();

/**
 * Type representing the local shortcut manager instance.
 * Provides methods to:
 * - Listen for keyboard events and trigger registered shortcuts
 * - Register new keyboard shortcuts with specific key combinations
 * - Unregister individual shortcuts or all shortcuts at once
 *
 * The manager handles the complexity of tracking pressed keys, matching
 * key combinations, and managing shortcut lifecycles.
 */

export const LocalShortcutManagerLive = {
	/**
	 * Sets up keyboard event listeners to detect and handle shortcut key combinations.
	 *
	 * - Tracks currently pressed keys in real-time
	 * - Matches key combinations against registered shortcuts
	 * - Handles both keydown and keyup events for flexible trigger options
	 * - Provides special handling for modifier keys to prevent stuck keys
	 * - Automatically cleans up state when window loses focus or visibility
	 *
	 * @param onTrigger - sink for matched edges; the command layer applies the
	 *   `on` filter and runs the callback. Called with `'Pressed'` when a combo
	 *   becomes fully held and `'Released'` when it stops being held.
	 * @returns Cleanup function that removes all event listeners when called
	 */
	listen(onTrigger: (id: CommandId, state: ShortcutEventState) => void) {
		/**
		 * Array tracking currently pressed keys in lowercase format.
		 * Maintains real-time state of which keys are physically held down.
		 * Updated on every keydown (adds key) and keyup (removes key) event.
		 */
		let pressedKeys: KeyboardEventSupportedKey[] = [];
		/**
		 * Set tracking which shortcuts have already been triggered and are currently active.
		 * This prevents key repeat spam when holding down keys - without this, holding
		 * spacebar would trigger the shortcut many times per second!
		 *
		 * When a shortcut is triggered:
		 * 1. Its ID is added to this set, marking it as "already fired"
		 * 2. Future keydown events with the same key combo are ignored
		 * 3. The ID is only removed when all keys are released or focus is lost
		 *
		 * This ensures each key combination fires exactly once per physical press,
		 * regardless of how long the user holds the keys down.
		 */
		const activeShortcuts = new Set<CommandId>();

		/**
		 * Handle keydown events - adds keys to pressed state and triggers 'Pressed' shortcuts.
		 * Fires repeatedly while a key is held down (due to OS key repeat), but activeShortcuts
		 * ensures callbacks only fire once per physical key press.
		 */
		const keydown = on(window, 'keydown', (e) => {
			// Skip shortcut processing if user is typing in an input field
			if (isTypingInInput()) return;

			let key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			// macOS Option key normalization:
			// On macOS, the Option key (Alt) triggers special character insertion.
			// For example, Option+A produces "å" instead of registering as "alt+a".
			// This breaks keyboard shortcut detection because we get the special
			// character instead of the actual key that was pressed.
			//
			// To fix this, when Option is held on macOS, we normalize these special
			// characters back to their base keys (e.g., "å" → "a", "ç" → "c").
			// This ensures keyboard shortcuts work consistently across platforms.
			if (os.isApple && pressedKeys.includes('alt')) {
				key = normalizeOptionKeyCharacter(key);
			}

			// Ignore keys that are not supported
			if (!isSupportedKey(key)) return;

			// Add key to pressed state if not already present
			if (!pressedKeys.includes(key)) pressedKeys.push(key);

			// Check all registered shortcuts for matches
			for (const [id, keyCombination] of shortcuts.entries()) {
				if (!arraysMatch(pressedKeys, keyCombination)) continue;

				// Always prevent default for matching shortcuts
				e.preventDefault();

				// Arm on the first full match and emit 'Pressed'. activeShortcuts is
				// the anti-spam latch: while a combo stays held, OS key repeat fires
				// keydown many times a second, but it emits 'Pressed' exactly once.
				// Arm regardless of which edges the command wants; the dispatcher
				// drops a 'Pressed' the command did not subscribe to, and arming is
				// what lets a release-only command still emit 'Released' on keyup.
				if (!activeShortcuts.has(id)) {
					activeShortcuts.add(id);
					onTrigger(id, 'Pressed');
				}
			}
		});

		/**
		 * Handle keyup events - removes keys from pressed state and triggers 'Released' shortcuts.
		 * Also responsible for clearing activeShortcuts to allow shortcuts to fire again
		 * on the next key press.
		 */
		const keyup = on(window, 'keyup', (e) => {
			// Skip shortcut processing if user is typing in an input field
			if (isTypingInInput()) return;

			const key = e.key.toLowerCase() as KeyboardEventPossibleKey;

			// Ignore keys that are not supported
			if (!isSupportedKey(key)) return;

			/** Modifier keys that require special handling */
			const modifierKeys = ['meta', 'control', 'alt', 'shift'];

			if (modifierKeys.includes(key)) {
				// Special handling for modifier keys (meta, control, alt, shift)
				// This addresses issues with OS/browser intercepting certain key combinations
				// where non-modifier keyup events might not fire properly
				// When a modifier key is released, clear all non-modifier keys
				// but keep other modifier keys that might still be pressed
				// This prevents keys from getting "stuck" in the pressedKeys state
				pressedKeys = pressedKeys.filter((k) => modifierKeys.includes(k));
				activeShortcuts.clear();
			}

			// Check all registered shortcuts for matches on release BEFORE removing the key
			for (const [id, keyCombination] of shortcuts.entries()) {
				if (!arraysMatch(pressedKeys, keyCombination)) continue;
				// Emit 'Released' for any combo that was armed; the dispatcher drops
				// it for commands that only subscribe to 'Pressed'.
				if (activeShortcuts.has(id)) {
					e.preventDefault();
					onTrigger(id, 'Released');
					activeShortcuts.delete(id);
				}
			}

			// Regular key removal from pressed state
			pressedKeys = pressedKeys.filter((k) => k !== key);

			// Clear active shortcuts when no keys are pressed
			if (pressedKeys.length === 0) {
				activeShortcuts.clear();
			}
		});

		/**
		 * Handle window blur events (switching applications, clicking outside browser)
		 * Reset all keys when user shifts focus away from the window
		 */
		const blur = on(window, 'blur', () => {
			pressedKeys = [];
			activeShortcuts.clear();
		});

		/**
		 * Handle tab visibility changes (switching browser tabs)
		 * This catches cases where the window doesn't lose focus but the tab is hidden
		 */
		const visibilityChange = on(document, 'visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				pressedKeys = [];
				activeShortcuts.clear();
			}
		});

		/** Cleanup function that removes all event listeners */
		return () => {
			keydown();
			keyup();
			blur();
			visibilityChange();
		};
	},
	async register({
		id,
		keyCombination,
	}: {
		id: CommandId;
		keyCombination: KeyboardEventSupportedKey[];
	}): Promise<Result<void, LocalShortcutError>> {
		shortcuts.set(id, keyCombination);
		return Ok(undefined);
	},

	/**
	 * Unregisters a local shortcut by ID.
	 * This function is idempotent - it can be safely called even if the shortcut
	 * with the given ID doesn't exist or has already been unregistered.
	 */
	async unregister(id: CommandId): Promise<Result<void, LocalShortcutError>> {
		shortcuts.delete(id);
		return Ok(undefined);
	},

	/**
	 * Unregisters all local shortcuts.
	 * This function is idempotent - it can be safely called even if no shortcuts
	 * are currently registered.
	 */
	async unregisterAll(): Promise<Result<void, LocalShortcutError>> {
		shortcuts.clear();
		return Ok(undefined);
	},
};

/**
 * Checks if two arrays contain the same elements, regardless of order.
 * Used to match pressed key combinations against registered shortcuts.
 *
 * @param a - First array of keys to compare
 * @param b - Second array of keys to compare
 * @returns True if both arrays contain exactly the same elements (same length and all elements present in both)
 *
 * @example
 * ```typescript
 * arraysMatch(['ctrl', 'a'], ['a', 'ctrl']) // returns true
 * arraysMatch(['ctrl', 'a'], ['ctrl', 'a', 'shift']) // returns false
 * ```
 */
function arraysMatch(a: string[], b: string[]) {
	return a.length === b.length && a.every((key) => b.includes(key));
}

/**
 * Checks if the currently focused element should capture keyboard input.
 * Returns true if the user is typing in an input field, textarea, or other editable element.
 * This prevents keyboard shortcuts from interfering with text input.
 */
function isTypingInInput(): boolean {
	const activeElement = document.activeElement;
	if (!activeElement) return false;

	// Check if it's an input element (but not buttons, checkboxes, etc.)
	if (activeElement.tagName === 'INPUT') {
		const inputType = (activeElement as HTMLInputElement).type;
		const textInputTypes = [
			'text',
			'password',
			'email',
			'url',
			'tel',
			'search',
			'number',
			'date',
			'time',
			'datetime-local',
			'month',
			'week',
		];
		return textInputTypes.includes(inputType);
	}

	// Check if it's a textarea
	if (activeElement.tagName === 'TEXTAREA') return true;

	// Check if it's a contenteditable element
	if (activeElement.getAttribute('contenteditable') === 'true') return true;

	// Check if it has role="textbox"
	if (activeElement.getAttribute('role') === 'textbox') return true;

	return false;
}

/**
 * Convert a shortcut string to an array of keys
 * @example "ctrl+shift+a" → ["ctrl", "shift", "a"]
 */
export function shortcutStringToArray(
	shortcut: string,
): KeyboardEventSupportedKey[] {
	return shortcut
		.split('+')
		.map((key) => key.toLowerCase() as KeyboardEventSupportedKey);
}

/**
 * Join an array of keys into a shortcut string
 * @example ["ctrl", "shift", "a"] → "ctrl+shift+a"
 */
export function arrayToShortcutString(
	keys: KeyboardEventSupportedKey[],
): string {
	return keys.map((key) => key.toLowerCase()).join('+');
}

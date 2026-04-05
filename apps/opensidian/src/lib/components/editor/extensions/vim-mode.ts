import { Compartment, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';

const STORAGE_KEY = 'opensidian.vim-mode';

const vimCompartment = new Compartment();

function isEnabled(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

function persist(enabled: boolean): void {
	try {
		localStorage.setItem(STORAGE_KEY, String(enabled));
	} catch {
		// Storage unavailable—silently ignore.
	}
}

/** Apply j→gj and k→gk remaps so cursor movement respects line wrapping. */
function applyLineWrapRemaps(): void {
	Vim.map('j', 'gj', 'normal');
	Vim.map('k', 'gk', 'normal');
}

/**
 * Build the vim mode extension, reading the current localStorage preference.
 *
 * Returns a fresh `Compartment.of(...)` each call so new EditorView instances
 * pick up the latest persisted preference—not a stale import-time snapshot.
 *
 * Must be placed **before** other keymap extensions so vim
 * keybindings take precedence.
 *
 * @example
 * ```typescript
 * import { vimModeExtension, toggleVimMode } from './extensions/vim-mode';
 *
 * // In the extension array (place early):
 * const extensions = [vimModeExtension(), ...otherExtensions];
 *
 * // Toggle from a button:
 * toggleVimMode(view, true);
 * ```
 */
export function vimModeExtension(): Extension {
	const enabled = isEnabled();
	if (enabled) applyLineWrapRemaps();
	return vimCompartment.of(enabled ? vim() : []);
}

/**
 * Toggle vim mode on or off at runtime.
 *
 * Dispatches a compartment reconfigure effect and persists the
 * preference to localStorage so it survives page reloads.
 */
export function toggleVimMode(view: EditorView, enabled: boolean): void {
	persist(enabled);
	if (enabled) applyLineWrapRemaps();

	view.dispatch({
		effects: vimCompartment.reconfigure(enabled ? vim() : []),
	});
}

/**
 * Whether vim mode is currently persisted as enabled.
 *
 * Reads from localStorage—useful for initialising toggle UI
 * without needing access to the EditorView.
 */
export function isVimModeEnabled(): boolean {
	return isEnabled();
}

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

/**
 * CodeMirror extension that provides an opt-in vim mode.
 *
 * Reads initial state from localStorage (`opensidian.vim-mode`).
 * Toggle at runtime with {@link toggleVimMode}.
 *
 * Must be placed **before** other keymap extensions so vim
 * keybindings take precedence.
 *
 * @example
 * ```typescript
 * import { vimModeExtension, toggleVimMode } from './extensions/vim-mode';
 *
 * // In the extension array (place early):
 * const extensions = [vimModeExtension, ...otherExtensions];
 *
 * // Toggle from a button:
 * toggleVimMode(view, true);
 * ```
 */
export const vimModeExtension: Extension = vimCompartment.of(
	isEnabled() ? vim() : [],
);

/**
 * Toggle vim mode on or off at runtime.
 *
 * Dispatches a compartment reconfigure effect and persists the
 * preference to localStorage so it survives page reloads.
 *
 * Also remaps `j→gj` and `k→gk` when enabling so cursor movement
 * respects line wrapping (standard for markdown editors).
 */
export function toggleVimMode(view: EditorView, enabled: boolean): void {
	persist(enabled);

	if (enabled) {
		Vim.map('j', 'gj', 'normal');
		Vim.map('k', 'gk', 'normal');
	}

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

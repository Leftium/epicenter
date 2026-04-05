import { Compartment, type Extension, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Vim, vim } from '@replit/codemirror-vim';

const VIM_STORAGE_KEY = 'opensidian.vim-mode';

// ── localStorage helpers ────────────────────────────────────────

function readVimPreference(): boolean {
	try {
		return localStorage.getItem(VIM_STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

function persistVimPreference(enabled: boolean): void {
	try {
		localStorage.setItem(VIM_STORAGE_KEY, String(enabled));
	} catch {
		// Storage unavailable—silently ignore.
	}
}

/** Remap j→gj and k→gk so cursor movement respects line wrapping. */
function applyLineWrapRemaps(): void {
	Vim.map('j', 'gj', 'normal');
	Vim.map('k', 'gk', 'normal');
}

// ── Word count ──────────────────────────────────────────────────

function countWords(doc: Text): number {
	let count = 0;
	const iter = doc.iter();
	while (!iter.next().done) {
		// Match sequences of word characters (handles unicode basics)
		const matches = iter.value.match(/\S+/g);
		if (matches) count += matches.length;
	}
	return count;
}

// ── Singleton factory ───────────────────────────────────────────

/**
 * Reactive editor state singleton.
 *
 * Bridges CodeMirror 6 editor state into Svelte 5 reactivity via
 * an `EditorView.updateListener` that pushes values into `$state`.
 * Components import the singleton and read getters directly—fine-grained
 * reactivity means only consumers of a changed value re-render.
 *
 * Follows the same factory pattern as `fs-state.svelte.ts` and
 * `terminal-state.svelte.ts`.
 *
 * @example
 * ```svelte
 * <script>
 *   import { editorState } from '$lib/state/editor-state.svelte';
 *   // Reactive reads — only re-render when the specific value changes
 *   const line = $derived(editorState.cursorLine);
 * </script>
 *
 * <span>Ln {editorState.cursorLine}, Col {editorState.cursorCol}</span>
 * <button onclick={() => editorState.toggleVim()}>
 *   {editorState.vimEnabled ? 'VIM' : 'NORMAL'}
 * </button>
 * ```
 */
function createEditorState() {
	// ── Reactive state ──────────────────────────────────────────
	let view = $state<EditorView | null>(null);
	let vimEnabled = $state(readVimPreference());
	let wordCount = $state(0);
	let cursorLine = $state(1);
	let cursorCol = $state(0);
	let selectionLength = $state(0);
	let lineCount = $state(1);

	// ── Vim compartment ─────────────────────────────────────────
	const vimCompartment = new Compartment();

	// ── Update listener (CM6 → $state bridge) ───────────────────
	const listener = EditorView.updateListener.of((update) => {
		if (update.docChanged) {
			wordCount = countWords(update.state.doc);
			lineCount = update.state.doc.lines;
		}
		if (update.selectionSet || update.docChanged) {
			const head = update.state.selection.main.head;
			const line = update.state.doc.lineAt(head);
			cursorLine = line.number;
			cursorCol = head - line.from;
			const { from, to } = update.state.selection.main;
			selectionLength = to - from;
		}
	});

	return {
		// ── Read-only getters ───────────────────────────────────
		get vimEnabled() {
			return vimEnabled;
		},
		get wordCount() {
			return wordCount;
		},
		get cursorLine() {
			return cursorLine;
		},
		get cursorCol() {
			return cursorCol;
		},
		get selectionLength() {
			return selectionLength;
		},
		get lineCount() {
			return lineCount;
		},

		/**
		 * Build the editor state extensions.
		 *
		 * Returns a fresh vim compartment (reading current localStorage)
		 * plus the update listener that bridges CM6 → `$state`.
		 * Call once per `EditorView` creation—do NOT reuse across views.
		 *
		 * Must be placed **before** other keymap extensions so vim
		 * keybindings take precedence when enabled.
		 */
		extension(): Extension[] {
			const enabled = readVimPreference();
			vimEnabled = enabled;
			if (enabled) applyLineWrapRemaps();
			return [vimCompartment.of(enabled ? vim() : []), listener];
		},

		/**
		 * Register the active EditorView.
		 *
		 * Call from the `$effect` that creates the view. For split-screen,
		 * call on focus change to update which editor feeds the status bar.
		 */
		attach(v: EditorView) {
			view = v;
			// Seed initial values from the editor's current state
			wordCount = countWords(v.state.doc);
			lineCount = v.state.doc.lines;
			const head = v.state.selection.main.head;
			const line = v.state.doc.lineAt(head);
			cursorLine = line.number;
			cursorCol = head - line.from;
			const { from, to } = v.state.selection.main;
			selectionLength = to - from;
		},

		/** Unregister the active EditorView (call from `$effect` cleanup). */
		detach() {
			view = null;
		},

		/**
		 * Toggle vim mode on the active editor.
		 *
		 * Persists preference to localStorage, reconfigures the compartment,
		 * and applies j/k line-wrap remaps when enabling.
		 */
		toggleVim() {
			const next = !vimEnabled;
			persistVimPreference(next);
			vimEnabled = next;
			if (next) applyLineWrapRemaps();
			view?.dispatch({
				effects: vimCompartment.reconfigure(next ? vim() : []),
			});
		},
	};
}

export const editorState = createEditorState();

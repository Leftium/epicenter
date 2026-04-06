<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { getLanguageExtensions } from './extensions/language-support';
	import { EditorState, type Extension } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import { Vim, getCM } from '@replit/codemirror-vim';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import type * as Y from 'yjs';
	import { editorState } from '$lib/state/editor-state.svelte';
	import { mode } from 'mode-watcher';

	let {
		ytext,
		filename = 'untitled.md',
		extensions: extraExtensions = [],
	}: {
		ytext: Y.Text;
		filename?: string;
		extensions?: Extension[];
	} = $props();

	let container: HTMLDivElement | undefined = $state();
	let currentView: EditorView | undefined = $state();
	$effect(() => {
		if (!container) return;

		const view = new EditorView({
			state: EditorState.create({
				doc: ytext.toString(),
				extensions: [
					// vim() must be BEFORE other keymaps per @replit/codemirror-vim README.
					// It uses ViewPlugin eventHandlers (DOM-level), not CM6 keymaps,
					// so ordering only affects insert-mode key fallthrough.
					...editorState.extension(mode.current === 'dark'),
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					...getLanguageExtensions(filename),
					yCollab(ytext, null),
					placeholder('Empty file'),
					...extraExtensions,
					EditorView.theme({
						'&': {
							height: '100%',
							fontSize: '14px',
						},
						'.cm-scroller': {
							fontFamily:
								'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
							padding: '1rem',
							overflow: 'auto',
						},
						'.cm-content': {
							caretColor: 'var(--foreground, currentColor)',
						},
						'.cm-focused': {
							outline: 'none',
						},
						'.cm-gutters': {
							display: 'none',
						},
						'.cm-activeLine': {
							backgroundColor: 'transparent',
						},
					}),
				],
			}),
			parent: container,
		});
		editorState.attach(view);
		currentView = view;

		return () => {
			view.destroy();
			editorState.detach();
			currentView = undefined;
		};
	});

	// Sync CM6 dark theme facet when color mode changes
	$effect(() => {
		editorState.syncDarkMode(mode.current === 'dark');
	});
	// Chrome blurs contenteditable when Escape is pressed, moving focus
	// to <body> before the keydown event dispatches. This means CM6 and
	// vim never see the Escape key. We intercept it at the window capture
	// phase, refocus the editor, and forward the key to vim directly.
	// See: https://github.com/replit/codemirror-vim/issues/138
	$effect(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			const view = currentView;
			if (!view) return;

			const cm = getCM(view);
			console.log('[vim-esc]', { cm: !!cm, vim: !!cm?.state?.vim, insert: cm?.state?.vim?.insertMode });
			if (!cm?.state?.vim) return;

			e.preventDefault();
			view.focus();
			Vim.handleKey(cm, '<Esc>', 'user');
		};
		window.addEventListener('keydown', handler, true);
		return () => window.removeEventListener('keydown', handler, true);
	});
</script>

<div
	class="h-full w-full overflow-hidden bg-transparent"
	bind:this={container}
></div>

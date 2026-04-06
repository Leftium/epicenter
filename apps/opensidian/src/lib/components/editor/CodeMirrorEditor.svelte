<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { getHighlightStyle, getLanguageExtensions } from './extensions/language-support';
	import { Compartment, EditorState, type Extension } from '@codemirror/state';
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
	const highlightCompartment = new Compartment();
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
					highlightCompartment.of(getHighlightStyle(filename, mode.current === 'dark')),
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
		const isDark = mode.current === 'dark';
		editorState.syncDarkMode(isDark);
		currentView?.dispatch({
			effects: highlightCompartment.reconfigure(getHighlightStyle(filename, isDark)),
		});
	});
	// Chrome blurs contenteditable when Escape is pressed, moving focus
	// to <body> before the keydown event dispatches to the editor's DOM.
	// This means CM6 and vim never see the Escape key.
	//
	// Fix: attach a capture-phase keydown listener directly on the
	// contenteditable element (view.contentDOM). Capture phase on the
	// target element fires BEFORE Chrome processes the blur. We call
	// preventDefault() to block the blur, then let vim handle Escape.
	// See: https://github.com/replit/codemirror-vim/issues/138
	$effect(() => {
		const view = currentView;
		if (!view) return;

		const handler = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			const cm = getCM(view);
			if (!cm?.state?.vim) return;

			// Prevent Chrome from blurring the contenteditable
			e.preventDefault();
			// Forward to vim
			Vim.handleKey(cm, '<Esc>', 'user');
		};
		// Capture phase on the contenteditable itself — fires before blur
		view.contentDOM.addEventListener('keydown', handler, true);
		return () => view.contentDOM.removeEventListener('keydown', handler, true);
	});
</script>

<div
	class="h-full w-full overflow-hidden bg-transparent"
	bind:this={container}
></div>

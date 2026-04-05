<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { EditorState, type Extension } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import type * as Y from 'yjs';
	import { markdownHighlighting } from './extensions/markdown-highlight';
	import { vimModeExtension } from './extensions/vim-mode';

	let {
		ytext,
		extensions: extraExtensions = [],
	}: {
		ytext: Y.Text;
		extensions?: Extension[];
	} = $props();

	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!container) return;

		const view = new EditorView({
			state: EditorState.create({
				doc: ytext.toString(),
				extensions: [
					vimModeExtension(),
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					markdownHighlighting,
					markdown(),
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

		return () => view.destroy();
	});
</script>

<div
	class="h-full w-full overflow-hidden bg-transparent"
	bind:this={container}
></div>

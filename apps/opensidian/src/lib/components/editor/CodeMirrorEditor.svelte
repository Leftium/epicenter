<script lang="ts">
	import { defaultKeymap, indentWithTab } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import {
		defaultHighlightStyle,
		syntaxHighlighting,
	} from '@codemirror/language';
	import { EditorState } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import type { FileId } from '@epicenter/filesystem';
	import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
	import type * as Y from 'yjs';
	import { linkDecorations } from './extensions/link-decorations';
	import { wikilinkAutocomplete } from './extensions/wikilink-autocomplete';

	let {
		ytext,
		onNavigate,
		resolveTitle,
		getFiles,
	}: {
		ytext: Y.Text;
		onNavigate: (fileId: FileId) => void;
		resolveTitle?: (fileId: FileId) => string | null;
		getFiles: () => Array<{ id: FileId; name: string; parentId: FileId | null }>;
	} = $props();

	let container: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!container) return;

		const view = new EditorView({
			state: EditorState.create({
				doc: ytext.toString(),
				extensions: [
					keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
					drawSelection(),
					EditorView.lineWrapping,
					syntaxHighlighting(defaultHighlightStyle),
					markdown(),
					yCollab(ytext, null),
					placeholder('Empty file'),
					linkDecorations({ onNavigate, resolveTitle }),
					wikilinkAutocomplete({ getFiles }),
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

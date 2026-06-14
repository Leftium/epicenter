<script lang="ts">
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { Compartment, EditorState } from '@codemirror/state';
	import {
		drawSelection,
		EditorView,
		keymap,
		placeholder,
	} from '@codemirror/view';
	import { untrack } from 'svelte';
	import { markdownLivePreview } from '$lib/editor/markdown-live-preview';
	import { markdownShortcutKeymap } from '$lib/editor/markdown-shortcuts';
	import { matterVimExtension } from '$lib/editor/vim-extension';

	type ActiveEditor = {
		view: EditorView;
		vimCompartment: Compartment;
		vimEnabled: boolean;
	};

	let {
		body,
		vimEnabled,
		onCommit,
	}: {
		body: string;
		vimEnabled: boolean;
		onCommit: (body: string) => void;
	} = $props();

	let container: HTMLDivElement | undefined;
	let editor: ActiveEditor | undefined;

	$effect(() => {
		if (!container) return;

		// RowDetailDialog remounts this editor on file changes. These props seed
		// one EditorView instance without making save echoes recreate it.
		const initialBody = untrack(() => body);
		const initialVimEnabled = untrack(() => vimEnabled);
		const vimCompartment = new Compartment();
		let draft = initialBody;
		let lastCommitted = initialBody;

		function commit() {
			if (draft === lastCommitted) return;
			lastCommitted = draft;
			onCommit(draft);
		}

		const editorView = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: initialBody,
				extensions: [
					vimCompartment.of(
						initialVimEnabled ? matterVimExtension() : [],
					),
					history(),
					keymap.of(markdownShortcutKeymap),
					keymap.of([...historyKeymap, ...defaultKeymap]),
					drawSelection(),
					EditorView.lineWrapping,
					markdown(),
					markdownLivePreview(),
					placeholder('Start writing'),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) draft = update.state.doc.toString();
					}),
					EditorView.domEventHandlers({
						blur: commit,
					}),
					EditorView.theme({
						'&': {
							minHeight: '22rem',
							backgroundColor: 'transparent',
							color: 'hsl(var(--foreground))',
							fontSize: '14px',
						},
						'&.cm-focused': {
							outline: 'none',
						},
						'.cm-scroller': {
							fontFamily:
								'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
							lineHeight: '1.65',
							overflow: 'auto',
						},
						'.cm-content': {
							minHeight: '22rem',
							padding: '1rem',
							caretColor: 'hsl(var(--foreground))',
						},
						'.cm-cursor': {
							borderLeftColor: 'hsl(var(--foreground))',
						},
						'.cm-gutters': { display: 'none' },
						'.cm-activeLine': { backgroundColor: 'transparent' },
						'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
							backgroundColor: 'hsl(var(--primary) / 0.18)',
						},
						'.cm-placeholder': {
							color: 'hsl(var(--muted-foreground))',
						},
					}),
				],
			}),
		});
		editor = {
			view: editorView,
			vimCompartment,
			vimEnabled: initialVimEnabled,
		};

		return () => {
			commit();
			editorView.destroy();
			if (editor?.view === editorView) editor = undefined;
		};
	});

	$effect(() => {
		const activeEditor = editor;
		if (!activeEditor) return;
		if (vimEnabled === activeEditor.vimEnabled) return;
		activeEditor.vimEnabled = vimEnabled;
		activeEditor.view.dispatch({
			effects: activeEditor.vimCompartment.reconfigure(
				vimEnabled ? matterVimExtension() : [],
			),
		});
	});
</script>

<div
	class="overflow-hidden rounded-md border bg-background shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
	bind:this={container}
></div>

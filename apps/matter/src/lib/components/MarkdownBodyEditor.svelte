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

	const matterEditorTheme = EditorView.theme({
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
	});

	type MountedEditor = {
		view: EditorView;
		vimCompartment: Compartment;
		appliedVimEnabled: boolean;
		/** Fresh state for `doc` with this editor's extensions. */
		stateFor: (doc: string, vim: boolean) => EditorState;
	};

	let {
		body = $bindable(),
		vimEnabled,
	}: {
		/** The accepted body. A different value replaces the document. */
		body: string;
		vimEnabled: boolean;
	} = $props();

	let container: HTMLDivElement | undefined;
	// Plain JS handle: assigning it must not make the Vim reconfigure effect run.
	let mountedEditor: MountedEditor | undefined;

	$effect(() => {
		if (!container) return;

		// The widget owns the document, selection, and undo history; `body` seeds it
		// here and the effect below replaces it only when the accepted body differs.
		const vimCompartment = new Compartment();
		const stateFor = (doc: string, vim: boolean) =>
			EditorState.create({
				doc,
				extensions: [
					vimCompartment.of(vim ? matterVimExtension() : []),
					history(),
					keymap.of(markdownShortcutKeymap),
					keymap.of([...historyKeymap, ...defaultKeymap]),
					drawSelection(),
					EditorView.lineWrapping,
					markdown(),
					markdownLivePreview(),
					placeholder('Start writing'),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) body = update.state.doc.toString();
					}),
					matterEditorTheme,
				],
			});

		const initialVimEnabled = untrack(() => vimEnabled);
		const editorView = new EditorView({
			parent: container,
			state: stateFor(
				untrack(() => body),
				initialVimEnabled,
			),
		});
		mountedEditor = {
			view: editorView,
			vimCompartment,
			appliedVimEnabled: initialVimEnabled,
			stateFor,
		};

		return () => {
			editorView.destroy();
			if (mountedEditor?.view === editorView) mountedEditor = undefined;
		};
	});

	// Typing publishes first, so the accepted body already equals the document and
	// nothing happens. A body that differs came from elsewhere (Discard, or the file
	// changing before any input here): show it in fresh state, as the file reads.
	// `setState` calls no update listener, so the replacement is not published back.
	$effect(() => {
		const accepted = body;
		const editor = mountedEditor;
		if (!editor || editor.view.state.doc.toString() === accepted) return;
		editor.view.setState(editor.stateFor(accepted, editor.appliedVimEnabled));
	});

	$effect(() => {
		const editor = mountedEditor;
		if (!editor) return;
		if (vimEnabled === editor.appliedVimEnabled) return;
		editor.appliedVimEnabled = vimEnabled;
		editor.view.dispatch({
			effects: editor.vimCompartment.reconfigure(
				vimEnabled ? matterVimExtension() : [],
			),
		});
	});
</script>

<div
	class="overflow-hidden rounded-md border bg-background shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
	bind:this={container}
></div>

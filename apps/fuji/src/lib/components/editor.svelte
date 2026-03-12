<script lang="ts">
	import { Editor, Extension } from '@tiptap/core';
	import Placeholder from '@tiptap/extension-placeholder';
	import StarterKit from '@tiptap/starter-kit';
	import { yCursorPlugin, ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';

	let {
		ytext,
		onContentChange,
	}: {
		ytext: Y.Text;
		onContentChange?: (content: { title: string; preview: string }) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();
	let editor: Editor | undefined = $state();

	/**
	 * Create a Tiptap extension that wraps y-prosemirror plugins for Yjs collaboration.
	 *
	 * Uses ySyncPlugin for binding ProseMirror state to Y.Text, and yUndoPlugin for
	 * collaborative undo/redo that respects per-client origins.
	 */
	function createYjsExtension(text: Y.Text) {
		return Extension.create({
			name: 'yjs-collaboration',
			addProseMirrorPlugins() {
				return [ySyncPlugin(text), yUndoPlugin()];
			},
		});
	}

	$effect(() => {
		if (!element) return;

		const yjsExtension = createYjsExtension(ytext);

		const ed = new Editor({
			element,
			extensions: [
				StarterKit.configure({
					// Disable built-in history — yUndoPlugin handles undo/redo
					history: false,
				}),
				Placeholder.configure({
					placeholder: 'Start writing…',
				}),
				yjsExtension,
			],
			editorProps: {
				attributes: {
					class:
						'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
				},
			},
			onUpdate({ editor: ed }) {
				if (!onContentChange) return;

				const text = ed.getText();
				const firstNewline = text.indexOf('\n');
				const firstLine =
					firstNewline === -1 ? text : text.slice(0, firstNewline);

				onContentChange({
					title: firstLine.slice(0, 80).trim(),
					preview: text.slice(0, 100).trim(),
				});
			},
		});

		editor = ed;

		// Fire initial content extraction
		if (onContentChange) {
			const text = ed.getText();
			const firstNewline = text.indexOf('\n');
			const firstLine =
				firstNewline === -1 ? text : text.slice(0, firstNewline);
			onContentChange({
				title: firstLine.slice(0, 80).trim(),
				preview: text.slice(0, 100).trim(),
			});
		}

		return () => {
			ed.destroy();
			editor = undefined;
		};
	});
</script>

<div class="flex h-full flex-col">
	<div bind:this={element} class="flex-1 overflow-y-auto p-8"></div>
</div>

<style>
	:global(.tiptap) {
		min-height: 100%;
	}
	:global(.tiptap p.is-editor-empty:first-child::before) {
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>

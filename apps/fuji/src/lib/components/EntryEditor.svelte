<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { Editor, Extension } from '@tiptap/core';
	import Placeholder from '@tiptap/extension-placeholder';
	import StarterKit from '@tiptap/starter-kit';
	import { format } from 'date-fns';
	import { ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';
	import type { Entry } from '$lib/workspace';
	import TagInput from './TagInput.svelte';

	let {
		entry,
		ytext,
		onUpdate,
		onBack,
	}: {
		entry: Entry;
		ytext: Y.Text;
		onUpdate: (
			updates: Partial<{ title: string; subtitle: string; type: string[]; tags: string[] }>,
		) => void;
		onBack: () => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}

	$effect(() => {
		if (!element) return;

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
				Extension.create({
					name: 'yjs-collaboration',
					addProseMirrorPlugins() {
						return [ySyncPlugin(ytext), yUndoPlugin()];
					},
				}),
			],
			editorProps: {
				attributes: {
					class:
						'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
				},
			},
		});

		return () => ed.destroy();
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header with back button -->
	<div class="flex items-center gap-2 border-b px-4 py-2">
		<Button variant="ghost" size="icon" class="size-7" onclick={onBack}>
			<ArrowLeftIcon class="size-4" />
		</Button>
		<span class="text-sm text-muted-foreground">Back to entries</span>
	</div>

	<!-- Entry metadata -->
	<div class="flex flex-col gap-3 border-b px-6 py-4">
		<input
			type="text"
			class="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
			placeholder="Entry title"
			value={entry.title}
			oninput={(e) => onUpdate({ title: e.currentTarget.value })}
		>
		<input
			type="text"
			class="w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/60"
			placeholder="Subtitle — a one-liner for your blog listing"
			value={entry.subtitle}
			oninput={(e) => onUpdate({ subtitle: e.currentTarget.value })}
		>

		<div class="flex flex-wrap items-center gap-4">
			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Type</span>
				<TagInput
					values={entry.type}
					placeholder="Add type…"
					onAdd={(value) =>
						onUpdate({ type: [...entry.type, value] })}
					onRemove={(value) =>
						onUpdate({
							type: entry.type.filter((t) => t !== value),
						})}
				/>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Tags</span>
				<TagInput
					values={entry.tags}
					placeholder="Add tag…"
					onAdd={(value) =>
						onUpdate({ tags: [...entry.tags, value] })}
					onRemove={(value) =>
						onUpdate({
							tags: entry.tags.filter((t) => t !== value),
						})}
				/>
			</div>
		</div>
	</div>

	<!-- Tiptap editor body -->
	<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>

	<!-- Timestamps footer -->
	<div
		class="flex items-center justify-end border-t px-6 py-2 text-xs text-muted-foreground"
	>
		<span>
			Created {format(parseDateTime(entry.createdAt), 'MMM d · h:mm a')}
			· Updated {format(parseDateTime(entry.updatedAt), 'MMM d · h:mm a')}
		</span>
	</div>
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

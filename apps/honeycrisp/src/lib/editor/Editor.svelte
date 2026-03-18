<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { Toggle } from '@epicenter/ui/toggle';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import BoldIcon from '@lucide/svelte/icons/bold';
	import Heading1Icon from '@lucide/svelte/icons/heading-1';
	import Heading2Icon from '@lucide/svelte/icons/heading-2';
	import Heading3Icon from '@lucide/svelte/icons/heading-3';
	import ItalicIcon from '@lucide/svelte/icons/italic';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import QuoteIcon from '@lucide/svelte/icons/quote';
	import StrikethroughIcon from '@lucide/svelte/icons/strikethrough';
	import UnderlineIcon from '@lucide/svelte/icons/underline';
	import { Editor } from '@tiptap/core';
	import Placeholder from '@tiptap/extension-placeholder';
	import TaskItem from '@tiptap/extension-task-item';
	import TaskList from '@tiptap/extension-task-list';
	import Underline from '@tiptap/extension-underline';
	import StarterKit from '@tiptap/starter-kit';
	import type * as Y from 'yjs';
	import { createYjsExtension } from './extensions';
	import { extractTitleAndPreview } from './utils';

	let {
		yxmlfragment,
		onContentChange,
	}: {
		yxmlfragment: Y.XmlFragment;
		onContentChange?: (content: {
			title: string;
			preview: string;
			wordCount: number;
		}) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();
	let editor: Editor | undefined = $state();
	let activeFormats = $state({
		bold: false,
		italic: false,
		underline: false,
		strike: false,
		heading1: false,
		heading2: false,
		heading3: false,
		bulletList: false,
		orderedList: false,
		taskList: false,
		blockquote: false,
	});

	const activeHeading = $derived(
		activeFormats.heading1
			? 'h1'
			: activeFormats.heading2
				? 'h2'
				: activeFormats.heading3
					? 'h3'
					: '',
	);

	const activeListType = $derived(
		activeFormats.bulletList
			? 'bullet'
			: activeFormats.orderedList
				? 'ordered'
				: activeFormats.taskList
					? 'task'
					: '',
	);

	$effect(() => {
		if (!element) return;

		const yjsExtension = createYjsExtension(yxmlfragment);

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
				TaskList,
				TaskItem.configure({ nested: true }),
				Underline,
				yjsExtension,
			],
			editorProps: {
				attributes: {
					class:
						'prose dark:prose-invert max-w-none focus:outline-none min-h-full',
				},
			},
			onUpdate({ editor: ed }) {
				if (!onContentChange) return;
				onContentChange(extractTitleAndPreview(ed));
			},
			onTransaction({ editor: ed }) {
				activeFormats = {
					bold: ed.isActive('bold'),
					italic: ed.isActive('italic'),
					underline: ed.isActive('underline'),
					strike: ed.isActive('strike'),
					heading1: ed.isActive('heading', { level: 1 }),
					heading2: ed.isActive('heading', { level: 2 }),
					heading3: ed.isActive('heading', { level: 3 }),
					bulletList: ed.isActive('bulletList'),
					orderedList: ed.isActive('orderedList'),
					taskList: ed.isActive('taskList'),
					blockquote: ed.isActive('blockquote'),
				};
			},
		});

		editor = ed;

		// Fire initial content extraction
		if (onContentChange) {
			onContentChange(extractTitleAndPreview(ed));
		}

		return () => {
			ed.destroy();
			editor = undefined;
		};
	});
</script>

{#snippet toggleButton(pressed: boolean, onToggle: () => void, icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<Toggle size="sm" {pressed} onPressedChange={onToggle}>
				<svelte:component this={icon} class="size-4" />
			</Toggle>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{#snippet groupItem(value: string, icon: typeof BoldIcon, label: string)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			<ToggleGroup.Item {value}>
				<svelte:component this={icon} class="size-4" />
			</ToggleGroup.Item>
		</Tooltip.Trigger>
		<Tooltip.Content>{label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

<div class="flex h-full flex-col">
	{#if editor}
		<div class="flex items-center gap-1 border-b p-2">
			{@render toggleButton(activeFormats.bold, () => editor?.chain().focus().toggleBold().run(), BoldIcon, 'Bold (⌘B)')}
			{@render toggleButton(activeFormats.italic, () => editor?.chain().focus().toggleItalic().run(), ItalicIcon, 'Italic (⌘I)')}
			{@render toggleButton(activeFormats.underline, () => editor?.chain().focus().toggleUnderline().run(), UnderlineIcon, 'Underline (⌘U)')}
			{@render toggleButton(activeFormats.strike, () => editor?.chain().focus().toggleStrike().run(), StrikethroughIcon, 'Strikethrough (⌘⇧S)')}

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeHeading}
				onValueChange={(value) => {
					const levels: Record<string, number> = { h1: 1, h2: 2, h3: 3 };
					const level = levels[value];
					if (level) editor?.chain().focus().toggleHeading({ level }).run();
				}}
			>
				{@render groupItem('h1', Heading1Icon, 'Heading 1')}
				{@render groupItem('h2', Heading2Icon, 'Heading 2')}
				{@render groupItem('h3', Heading3Icon, 'Heading 3')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			<ToggleGroup.Root
				type="single"
				size="sm"
				value={activeListType}
				onValueChange={(value) => {
					const commands: Record<string, () => void> = {
						bullet: () => editor?.chain().focus().toggleBulletList().run(),
						ordered: () => editor?.chain().focus().toggleOrderedList().run(),
						task: () => editor?.chain().focus().toggleTaskList().run(),
					};
					commands[value]?.();
				}}
			>
				{@render groupItem('bullet', ListIcon, 'Bullet List')}
				{@render groupItem('ordered', ListOrderedIcon, 'Ordered List')}
				{@render groupItem('task', ListChecksIcon, 'Checklist')}
			</ToggleGroup.Root>

			<Separator orientation="vertical" class="mx-1 h-6" />

			{@render toggleButton(activeFormats.blockquote, () => editor?.chain().focus().toggleBlockquote().run(), QuoteIcon, 'Blockquote (⌘⇧B)')}
		</div>
	{/if}
	<div bind:this={element} class="flex-1 overflow-y-auto p-8"></div>
</div>

<style>
	:global(.tiptap) {
		min-height: 100%;
	}
	:global(.tiptap > *:first-child) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
	}
	:global(.tiptap p.is-editor-empty:first-child::before) {
		font-size: 1.75rem;
		font-weight: 700;
		line-height: 1.2;
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
	:global(.tiptap ul[data-type="taskList"]) {
		list-style: none;
		padding-left: 0;
	}
	:global(.tiptap ul[data-type="taskList"] li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	:global(.tiptap ul[data-type="taskList"] li > label) {
		margin-top: 0.25rem;
	}
</style>

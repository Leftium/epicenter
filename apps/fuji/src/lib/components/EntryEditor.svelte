<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import {
		localTimezone,
		NaturalLanguageDateInput,
		toDateTimeString,
	} from '@epicenter/ui/natural-language-date-input';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import * as Popover from '@epicenter/ui/popover';
	import { DateTimeString } from '@epicenter/workspace';
	import { format } from 'date-fns';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { baseKeymap, toggleMark } from 'prosemirror-commands';
	import {
		inputRules,
		wrappingInputRule,
		textblockTypeInputRule,
		smartQuotes,
		emDash,
		ellipsis,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import { Schema, type MarkSpec } from 'prosemirror-model';
	import {
		addListNodes,
		splitListItem,
		liftListItem,
		sinkListItem,
	} from 'prosemirror-schema-list';
	import { schema as basicSchema } from 'prosemirror-schema-basic';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { ySyncPlugin, yUndoPlugin, undo, redo } from 'y-prosemirror';
	import type * as Y from 'yjs';
	import type { Entry } from '$lib/workspace';
	import TagInput from './TagInput.svelte';
	import { viewState } from '$lib/view.svelte';
	import { workspace } from '$lib/client';

	let {
		entry,
		yxmlfragment,
	}: {
		entry: Entry;
		yxmlfragment: Y.XmlFragment;
	} = $props();

	function updateEntry(updates: Partial<{ title: string; subtitle: string; type: string[]; tags: string[]; date: DateTimeString }>) {
		workspace.actions.entries.update({ id: entry.id, ...updates });
	}

	let element: HTMLDivElement | undefined = $state();
	let wordCount = $state(0);

	let isDatePopoverOpen = $state(false);
	let dateTz = $state(localTimezone());

	function countWords(text: string): number {
		const trimmed = text.trim();
		if (!trimmed) return 0;
		return trimmed.split(/\s+/).length;
	}

	function createWordCountPlugin() {
		return new Plugin({
			view() {
				return {
					update(view) {
						wordCount = countWords(view.state.doc.textContent);
					},
				};
			},
		});
	}

	const extraMarks: Record<string, MarkSpec> = {
		strikethrough: {
			parseDOM: [
				{ tag: 's' },
				{ tag: 'del' },
				{ style: 'text-decoration=line-through' },
			],
			toDOM() {
				return ['s', 0];
			},
		},
		underline: {
			parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
			toDOM() {
				return ['u', 0];
			},
		},
	};

	const schema = new Schema({
		nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
		marks: basicSchema.spec.marks.append(extraMarks),
	});

	function createPlaceholderPlugin(text: string) {
		return new Plugin({
			props: {
				decorations(state) {
					const { doc } = state;
					if (
						doc.childCount === 1 &&
						doc.firstChild?.isTextblock &&
						doc.firstChild.content.size === 0
					) {
						return DecorationSet.create(doc, [
							Decoration.node(0, doc.firstChild.nodeSize, {
								class: 'is-editor-empty',
								'data-placeholder': text,
							}),
						]);
					}
					return DecorationSet.empty;
				},
			},
		});
	}

	$effect(() => {
		if (!element) return;

		const view = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					ySyncPlugin(yxmlfragment),
					yUndoPlugin(),
					createPlaceholderPlugin('Start writing\u2026'),
					keymap({
						'Mod-z': undo,
						'Mod-y': redo,
						'Mod-Shift-z': redo,
						'Mod-b': toggleMark(schema.marks.strong!),
						'Mod-i': toggleMark(schema.marks.em!),
						'Mod-u': toggleMark(schema.marks.underline!),
						'Mod-Shift-s': toggleMark(schema.marks.strikethrough!),
						Enter: splitListItem(schema.nodes.list_item!),
						'Mod-]': sinkListItem(schema.nodes.list_item!),
						Tab: sinkListItem(schema.nodes.list_item!),
						'Mod-[': liftListItem(schema.nodes.list_item!),
						'Shift-Tab': liftListItem(schema.nodes.list_item!),
					}),
					keymap(baseKeymap),
					inputRules({
						rules: [
							...smartQuotes,
							emDash,
							ellipsis,
							textblockTypeInputRule(
								/^(#{1,3})\s$/,
								schema.nodes.heading!,
								(match) => ({ level: match[1]!.length }),
							),
							wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
							wrappingInputRule(
								/^(\d+)\.\s$/,
								schema.nodes.ordered_list!,
								(match) => ({ order: +match[1]! }),
								(match, node) =>
									node.childCount + node.attrs.order === +match[1]!,
							),
							wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote!),
							textblockTypeInputRule(/^```$/, schema.nodes.code_block!),
						],
					}),
					createWordCountPlugin(),
				],
			}),
			attributes: {
				class:
					'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-full',
			},
		});

		return () => view.destroy();
	});
</script>

<div class="flex h-full flex-col">
	<!-- Header with back button -->
	<div class="flex items-center justify-between border-b px-4 py-2">
		<div class="flex items-center gap-2">
			<Button variant="ghost" size="icon" class="size-7" onclick={() => viewState.selectEntry(null)}>
				<ArrowLeftIcon class="size-4" />
			</Button>
			<span class="text-sm text-muted-foreground">Back to entries</span>
		</div>
		<Button
			variant="ghost-destructive"
			size="icon"
			class="size-7"
			onclick={() => {
				confirmationDialog.open({
					title: 'Delete entry?',
					description: `"${entry.title || 'Untitled'}" will be moved to recently deleted.`,
					confirm: { text: 'Delete', variant: 'destructive' },
					onConfirm: () => {
						workspace.actions.entries.delete({ id: entry.id });
						viewState.selectEntry(null);
					},
				});
			}}
		>
			<Trash2Icon class="size-4" />
		</Button>
	</div>

	<!-- Entry metadata -->
	<div class="flex flex-col gap-3 border-b px-6 py-4">
		<input
			type="text"
			class="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
			placeholder="Entry title"
			value={entry.title}
			oninput={(e) => updateEntry({ title: e.currentTarget.value })}
		>
		<input
			type="text"
			class="w-full bg-transparent text-sm text-muted-foreground outline-none placeholder:text-muted-foreground/60"
			placeholder="Subtitle — a one-liner for your blog listing"
			value={entry.subtitle}
			oninput={(e) => updateEntry({ subtitle: e.currentTarget.value })}
		>

		<div class="flex flex-wrap items-center gap-4">
			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Type</span>
				<TagInput
					values={entry.type}
					placeholder="Add type…"
					onAdd={(value) =>
						updateEntry({ type: [...entry.type, value] })}
					onRemove={(value) =>
						updateEntry({
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
						updateEntry({ tags: [...entry.tags, value] })}
					onRemove={(value) =>
						updateEntry({
							tags: entry.tags.filter((t) => t !== value),
						})}
				/>
			</div>

			<div class="flex items-center gap-2">
				<span class="text-xs font-medium text-muted-foreground">Date</span>
				<Popover.Root bind:open={isDatePopoverOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="cursor-pointer rounded-md border bg-background px-2.5 py-1 text-sm transition hover:bg-accent"
							>
								{format(DateTimeString.toDate(entry.date), 'MMM d, yyyy · h:mm a')}
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						side="bottom"
						align="start"
						class="w-80 space-y-3 p-3"
					>
						<NaturalLanguageDateInput
							onChoice={({ date }) => {
								updateEntry({ date: toDateTimeString(date, dateTz) });
								isDatePopoverOpen = false;
							}}
						/>
						<TimezoneCombobox bind:value={dateTz} />
					</Popover.Content>
				</Popover.Root>
			</div>
		</div>
	</div>

	<!-- Editor body -->
	<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>

	<!-- Status bar -->
	<div
		class="flex items-center justify-between border-t px-4 py-1.5 text-xs text-muted-foreground"
	>
		<span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
		<div class="flex items-center gap-3">
			<span
				>Created
				{format(DateTimeString.toDate(entry.createdAt), 'MMM d, yyyy · h:mm a')}</span
			>
			<span
				>Updated
				{format(DateTimeString.toDate(entry.updatedAt), 'MMM d, yyyy · h:mm a')}</span
			>
		</div>
	</div>
</div>

<style>
	:global(.ProseMirror) {
		min-height: 100%;
	}
	:global(.ProseMirror p.is-editor-empty:first-child::before) {
		color: hsl(var(--muted-foreground));
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}
</style>

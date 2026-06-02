<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { untrack } from 'svelte';
	import { baseKeymap, toggleMark } from 'prosemirror-commands';
	import {
		ellipsis,
		emDash,
		inputRules,
		smartQuotes,
		textblockTypeInputRule,
		wrappingInputRule,
	} from 'prosemirror-inputrules';
	import { keymap } from 'prosemirror-keymap';
	import {
		liftListItem,
		sinkListItem,
		splitListItem,
	} from 'prosemirror-schema-list';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { redo, undo, ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import { requireFuji } from '$lib/session';
	import type { EntryId } from '$lib/workspace';
	import { entryBodySchema as schema } from '$lib/workspace/entry-body-schema';

	let {
		entryId,
		onWordCountChange,
	}: {
		entryId: EntryId;
		onWordCountChange?: (count: number) => void;
	} = $props();

	const fuji = requireFuji();
	// svelte-ignore state_referenced_locally - EntryEditor remounts this component by entry id
	const contentDoc = fuji.entryBodies.open(entryId);
	$effect(() => () => contentDoc[Symbol.dispose]());

	let element: HTMLDivElement | undefined = $state();

	function createWordCountPlugin() {
		let previousCount: number | undefined;
		const onChange = untrack(() => onWordCountChange);

		function report(view: EditorView) {
			const textContent = view.state.doc.textContent.trim();
			const nextCount = textContent ? textContent.split(/\s+/).length : 0;
			if (nextCount === previousCount) return;

			previousCount = nextCount;
			onChange?.(nextCount);
		}

		return new Plugin({
			view(view) {
				report(view);
				return {
					update: report,
				};
			},
		});
	}

	$effect(() => {
		if (!element) return;

		const placeholderPlugin = new Plugin({
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
								'data-placeholder': 'Start writing...',
							}),
						]);
					}
					return DecorationSet.empty;
				},
			},
		});

		const view = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					ySyncPlugin(contentDoc.binding),
					yUndoPlugin(),
					placeholderPlugin,
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

{#await contentDoc.whenLoaded}
	<Loading class="flex-1" />
{:then _}
	<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>
{/await}

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

<script lang="ts">
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
	import { type MarkSpec, Schema } from 'prosemirror-model';
	import { schema as basicSchema } from 'prosemirror-schema-basic';
	import {
		addListNodes,
		liftListItem,
		sinkListItem,
		splitListItem,
	} from 'prosemirror-schema-list';
	import { EditorState, Plugin } from 'prosemirror-state';
	import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
	import 'prosemirror-view/style/prosemirror.css';
	import { redo, undo, ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
	import type * as Y from 'yjs';

	let {
		yxmlfragment,
		onWordCountChange,
	}: {
		yxmlfragment: Y.XmlFragment;
		onWordCountChange?: (count: number) => void;
	} = $props();

	let element: HTMLDivElement | undefined = $state();

	// ─── Schema ──────────────────────────────────────────────────────────────

	const extraMarks = {
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
	} satisfies Record<string, MarkSpec>;

	const schema = new Schema({
		nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
		marks: basicSchema.spec.marks.append(extraMarks),
	});

	// ─── Plugins ─────────────────────────────────────────────────────────────

	function createWordCountPlugin() {
		let previousCount: number | undefined;

		return new Plugin({
			view() {
				return {
					update(view) {
						const textContent = view.state.doc.textContent.trim();
						const nextCount = textContent ? textContent.split(/\s+/).length : 0;
						if (nextCount === previousCount) return;

						previousCount = nextCount;
						onWordCountChange?.(nextCount);
					},
				};
			},
		});
	}

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

	// ─── Editor lifecycle ────────────────────────────────────────────────────

	$effect(() => {
		if (!element) return;

		const view = new EditorView(element, {
			state: EditorState.create({
				schema,
				plugins: [
					ySyncPlugin(yxmlfragment),
					yUndoPlugin(),
					createPlaceholderPlugin('Start writing…'),
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

<div bind:this={element} class="flex-1 overflow-y-auto px-6 py-4"></div>

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

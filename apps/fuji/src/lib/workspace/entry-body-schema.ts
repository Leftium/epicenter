/**
 * The single ProseMirror schema for fuji entry bodies.
 *
 * Shared by the editor (`EntryBodyEditor.svelte`) and the markdown serializer
 * (`entry-body-markdown.ts`) so the two can never drift: edits and reads agree
 * on the exact node and mark set. It is the basic schema plus list nodes plus
 * two custom marks (underline, strikethrough) the editor exposes.
 */

import { type MarkSpec, Schema } from 'prosemirror-model';
import { schema as basicSchema } from 'prosemirror-schema-basic';
import { addListNodes } from 'prosemirror-schema-list';

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

export const entryBodySchema = new Schema({
	nodes: addListNodes(basicSchema.spec.nodes, 'paragraph block*', 'block'),
	marks: basicSchema.spec.marks.append(extraMarks),
});

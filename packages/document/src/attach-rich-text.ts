/**
 * attachRichText() — Bind a `Y.XmlFragment` slot on a Y.Doc to a typed handle.
 *
 * Reserves `ydoc.getXmlFragment(key)` and hands back `{ binding, read, write }`.
 * The `binding` is what you feed into a ProseMirror/Tiptap Yjs extension; `read`
 * flattens the fragment to plain text; `write` replaces the fragment with a
 * single paragraph of plain text (useful for programmatic seed/reset, not for
 * editor input — the editor mutates `binding` directly).
 *
 * Handle-style attachment: synchronous, no async teardown. Destroying the
 * `Y.Doc` releases the fragment along with the rest of the doc.
 *
 * @example
 * ```ts
 * const ydoc = new Y.Doc({ guid: 'note-1', gc: false });
 * const content = attachRichText(ydoc);
 * content.write('Hello');           // programmatic seed
 * tiptapEditor.use(ySyncPlugin(content.binding)); // editor-driven edits
 * ```
 */
import * as Y from 'yjs';

export type RichTextAttachment = {
	/** `Y.XmlFragment` — pass this to a ProseMirror/Tiptap Yjs binding. */
	binding: Y.XmlFragment;
	/** Flatten the fragment to plain text. */
	read: () => string;
	/** Replace the fragment with a single paragraph containing `text`. */
	write: (text: string) => void;
};

/**
 * Attach a rich-text handle to `ydoc` at `key` (default `'content'`).
 *
 * @param ydoc - Y.Doc to attach to
 * @param key  - Name of the `Y.XmlFragment` slot on the doc
 */
export function attachRichText(
	ydoc: Y.Doc,
	key = 'content',
): RichTextAttachment {
	const fragment = ydoc.getXmlFragment(key);
	return {
		binding: fragment,
		read() {
			return fragmentToPlaintext(fragment);
		},
		write(text) {
			ydoc.transact(() => {
				while (fragment.length > 0) {
					fragment.delete(0, 1);
				}
				const paragraph = new Y.XmlElement('paragraph');
				paragraph.insert(0, [new Y.XmlText(text)]);
				fragment.insert(0, [paragraph]);
			});
		},
	};
}

function fragmentToPlaintext(fragment: Y.XmlFragment): string {
	let out = '';
	for (const child of fragment.toArray()) {
		if (child instanceof Y.XmlText) out += child.toString();
		else if (child instanceof Y.XmlElement)
			out += fragmentToPlaintext(child as unknown as Y.XmlFragment);
	}
	return out;
}

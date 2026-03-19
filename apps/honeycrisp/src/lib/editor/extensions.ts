/**
 * Tiptap extensions for Honeycrisp's rich-text editor.
 */

import { Extension } from '@tiptap/core';
import { ySyncPlugin, yUndoPlugin } from 'y-prosemirror';
import type * as Y from 'yjs';

/**
 * Create a Tiptap extension that wraps y-prosemirror plugins for Yjs collaboration.
 *
 * Uses ySyncPlugin for binding ProseMirror state to Y.XmlFragment, and yUndoPlugin for
 * collaborative undo/redo that respects per-client origins.
 *
 * @example
 * ```typescript
 * const yjsExtension = createYjsExtension(yxmlfragment);
 * const editor = new Editor({ extensions: [StarterKit, yjsExtension] });
 * ```
 */
export function createYjsExtension(xmlFragment: Y.XmlFragment) {
	return Extension.create({
		name: 'yjs-collaboration',
		addProseMirrorPlugins() {
			return [ySyncPlugin(xmlFragment), yUndoPlugin()];
		},
	});
}

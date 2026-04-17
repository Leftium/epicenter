/**
 * Built-in content strategies for `.withDocument()`.
 *
 * Each strategy is a `ContentStrategy` — a function that receives the document's
 * Y.Doc and returns a typed binding that becomes `handle.content`.
 *
 * @module
 */
import * as Y from 'yjs';
import { createTimeline, type Timeline } from '../timeline/timeline.js';

/**
 * Plain text content strategy.
 *
 * Returns a Y.Text bound to the document. Use for documents that are always
 * plain text — markdown files, code, skill instructions, plain notes.
 *
 * The returned Y.Text can be bound directly to CodeMirror, Monaco, or any
 * editor that accepts Y.Text via y-codemirror or similar bindings.
 *
 * @example
 * ```typescript
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   content: plainText,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const handle = await workspace.documents.files.content.open(file);
 * const ytext = handle.content; // Y.Text — fully typed
 * editor.bind(ytext);
 * ```
 */
export const plainText: (ydoc: Y.Doc) => Y.Text = (ydoc) =>
	ydoc.getText('content');

/**
 * Rich text content strategy.
 *
 * Returns a Y.XmlFragment bound to the document. Use for documents edited
 * with ProseMirror, TipTap, or other block editors via y-prosemirror.
 *
 * The returned Y.XmlFragment can be bound directly to ProseMirror via
 * `ySyncPlugin(fragment)` from y-prosemirror.
 *
 * @example
 * ```typescript
 * const notesTable = defineTable(
 *   type({ id: 'string', title: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('body', {
 *   content: richText,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const handle = await workspace.documents.notes.body.open(note);
 * const fragment = handle.content; // Y.XmlFragment — fully typed
 * const plugins = [ySyncPlugin(fragment)];
 * ```
 */
export const richText: (ydoc: Y.Doc) => Y.XmlFragment = (ydoc) =>
	ydoc.getXmlFragment('content');

/**
 * Timeline content strategy — multi-mode document with format switching.
 *
 * Returns the existing Timeline object, supporting runtime switching between
 * text, richtext, and sheet modes via `asText()` / `asRichText()` / `asSheet()`.
 *
 * Use for documents that need runtime mode switching — e.g., opensidian files
 * that toggle between source markdown and rich text editing, or spreadsheet
 * files that can also be viewed as CSV text.
 *
 * @example
 * ```typescript
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   content: timeline,
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * // At runtime:
 * const handle = await workspace.documents.files.content.open(file);
 * handle.content.asText();      // content is Timeline — fully typed
 * handle.content.asRichText();
 * handle.content.asSheet();
 * handle.content.read();
 * handle.content.write('hello');
 */
export const timeline: (ydoc: Y.Doc) => Timeline = (ydoc) =>
	createTimeline(ydoc);

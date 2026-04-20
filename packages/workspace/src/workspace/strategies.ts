/**
 * Built-in content strategies for `.withDocument()`.
 *
 * Each strategy is a `ContentStrategy` — a function that receives the document's
 * Y.Doc and returns a typed content object directly from `open()`.
 *
 * `plainText` and `richText` delegate to `attachPlainText` / `attachRichText`
 * from `@epicenter/document` — those are the canonical primitives for binding
 * a Y.Text or Y.XmlFragment slot on a Y.Doc. Timeline is workspace-specific
 * (multi-mode text/richtext/sheet with append-only entry log) and stays here.
 *
 * Every strategy satisfies `ContentHandle` — consumers can always `read()` and
 * `write()` without touching Y.Doc internals. Editor-specific bindings are
 * available via `.binding` (Y.Text, Y.XmlFragment) or mode-switching methods
 * (Timeline).
 *
 * @module
 */
import {
	attachPlainText,
	attachRichText,
	type PlainTextAttachment,
	type RichTextAttachment,
} from '@epicenter/document';
import type * as Y from 'yjs';
import { createTimeline, type Timeline } from '../timeline/timeline.js';

/**
 * Plain text content strategy.
 *
 * Delegates to `attachPlainText` — reserves `ydoc.getText('content')` and
 * returns `{ binding, read, write }`. Use for documents that are always plain
 * text — markdown files, code, skill instructions, plain notes.
 *
 * `write()` handles `ydoc.transact()` internally, so consumers never need
 * direct Y.Doc access. The `binding` property exposes the raw Y.Text for
 * editor integration (CodeMirror via y-codemirror, Monaco, etc.).
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
 * const content = await workspace.documents.files.content.open(file);
 * content.read();             // string
 * content.write('hello');     // replaces content, transact handled internally
 * editor.bind(content.binding); // Y.Text for editor binding
 * ```
 */
export const plainText: (ydoc: Y.Doc) => PlainTextAttachment = (ydoc) =>
	attachPlainText(ydoc);

/**
 * Rich text content strategy.
 *
 * Delegates to `attachRichText` — reserves `ydoc.getXmlFragment('content')`
 * and returns `{ binding, read, write }`. Use for documents edited with
 * ProseMirror, TipTap, or other block editors via y-prosemirror.
 *
 * `write(text)` clears the fragment and inserts a paragraph node with the
 * given text. `read()` flattens the fragment to plain text with block-aware
 * newlines (paragraphs, headings, etc. produce line breaks). The `binding`
 * property exposes the raw Y.XmlFragment for y-prosemirror.
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
 * const content = await workspace.documents.notes.body.open(note);
 * content.read();                // string (strips formatting)
 * content.write('hello');        // replaces content
 * const plugins = [ySyncPlugin(content.binding)]; // Y.XmlFragment for ProseMirror
 * ```
 */
export const richText: (ydoc: Y.Doc) => RichTextAttachment = (ydoc) =>
	attachRichText(ydoc);

/**
 * Timeline content strategy — multi-mode document with format switching.
 *
 * Returns the existing Timeline object, which already satisfies `ContentHandle`
 * (`read()` and `write()` are built in). Supports runtime switching between
 * text, richtext, and sheet modes via `asText()` / `asRichText()` / `asSheet()`.
 *
 * Unlike `plainText` and `richText` — which bind a single shared type at a
 * fixed doc slot — Timeline stores an append-only log of typed entries in one
 * Y.Array slot, and "current mode" is the last entry. It therefore can't be
 * expressed as a composition of `attachPlainText` + `attachRichText` and has
 * no attach* analog in `@epicenter/document` yet.
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
 * const content = await workspace.documents.files.content.open(file);
 * content.asText();      // Y.Text for CodeMirror binding
 * content.asRichText();  // Y.XmlFragment for ProseMirror binding
 * content.asSheet();     // SheetBinding for spreadsheet
 * content.read();        // string (mode-dependent)
 * content.write('hello');
 * ```
 */
export const timeline: (ydoc: Y.Doc) => Timeline = (ydoc) =>
	createTimeline(ydoc);

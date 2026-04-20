/**
 * Built-in content strategies for `.withDocument()`.
 *
 * Each strategy is a `ContentStrategy` — a function that receives the document's
 * Y.Doc and returns a typed content object directly from `open()`. All three
 * delegate to `@epicenter/document` attach primitives:
 *
 * - `plainText` → `attachPlainText`
 * - `richText`  → `attachRichText`
 * - `timeline`  → `attachTimeline`
 *
 * The wrappers exist for JSDoc examples scoped to `.withDocument` usage and to
 * narrow the signature to `(ydoc: Y.Doc) => TBinding`. The strategies are kept
 * as named exports so call sites read `content: plainText` instead of reaching
 * into the primitives package.
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
	attachTimeline,
	type PlainTextAttachment,
	type RichTextAttachment,
	type Timeline,
} from '@epicenter/document';
import type * as Y from 'yjs';

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
 * Delegates to `attachTimeline` — reserves `ydoc.getArray('timeline')` as an
 * append-only log of typed entries (text, richtext, sheet) and returns a
 * handle with `read()`, `write()`, and mode-switching methods (`asText()`,
 * `asRichText()`, `asSheet()`). "Current mode" is the last entry in the log.
 *
 * Unlike `plainText` and `richText` — which bind a single shared type at a
 * fixed doc slot — Timeline stores all content types inside Y.Array entries,
 * so mode switches append a new entry instead of mutating a shared slot in
 * place. That's why Timeline has its own primitive rather than composing over
 * the simpler attach* helpers.
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
	attachTimeline(ydoc);

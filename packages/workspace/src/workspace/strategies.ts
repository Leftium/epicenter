/**
 * Built-in content strategies for `.withDocument()`.
 *
 * Each strategy is a `ContentStrategy<T>` — a function `(ydoc: Y.Doc) => T`
 * that receives the per-row content Y.Doc and returns a typed handle. The
 * three strategies below are direct renames of the attach primitives from
 * `@epicenter/document`; they exist as named workspace exports so call
 * sites read naturally:
 *
 * ```typescript
 * defineTable(schema).withDocument('content', {
 *   content: plainText,                    // or richText, or timeline
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 * ```
 *
 * | Strategy    | Primitive         | Returns                             | Use case                                    |
 * |-------------|-------------------|-------------------------------------|---------------------------------------------|
 * | `plainText` | `attachPlainText` | `{ binding: Y.Text, read, write }`  | Markdown, code, plain notes                 |
 * | `richText`  | `attachRichText`  | `{ binding: Y.XmlFragment, read, write }` | ProseMirror/Tiptap block editors     |
 * | `timeline`  | `attachTimeline`  | `Timeline` (append-only typed log)  | Multi-mode docs with format switching       |
 *
 * All three satisfy `ContentHandle` — `read()` returns a string and
 * `write(text)` replaces the content in a single transaction. Editors bind
 * through the `binding` property (Y.Text / Y.XmlFragment) or, for timeline,
 * via `asText()` / `asRichText()` / `asSheet()` mode-switching methods.
 *
 * @module
 */

export {
	attachPlainText as plainText,
	attachRichText as richText,
	attachTimeline as timeline,
} from '@epicenter/document';

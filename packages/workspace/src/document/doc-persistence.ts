/**
 * Consumer contract for `attachPersistence` callbacks on per-row document
 * factories (`createFileContentDoc`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`, and similar app-level wrappers).
 *
 * Both fields are required: every real persistence attachment signals
 * initial-load readiness and final teardown, and requiring them here catches
 * missing providers at the callback's definition site instead of at runtime.
 * Attachments without async teardown can set `whenDisposed: Promise.resolve()`.
 *
 * This is a *consumer contract*, not a produced attachment: there is no
 * `attachPersistence()` function. Real producers (`attachIndexedDb`,
 * `attachSqlite`) return richer types that structurally satisfy this shape.
 */
export type DocPersistence = {
	whenLoaded: Promise<unknown>;
	whenDisposed: Promise<unknown>;
};

/**
 * Browser-only extension of `DocPersistence`. Adds `clearLocal()` for
 * resetting a single live document's stored state (the workspace's
 * `clearLocalData()` flow uses this on root persistence).
 *
 * Kept separate from `DocPersistence` because `attachSqlite()` does not
 * expose `clearLocal()` today, and the shared filesystem builders run in
 * non-browser contexts. Browser-side wrappers opt in by typing their
 * persistence handle as `BrowserDocPersistence`.
 *
 * `attachIndexedDb()` already returns a richer attachment that
 * structurally satisfies this shape.
 */
export type BrowserDocPersistence = DocPersistence & {
	clearLocal(): Promise<void>;
};

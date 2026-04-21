/**
 * Contract type for content-doc factory `attach` callbacks.
 *
 * Content-doc factories (`createFileContentDocs`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`) accept an `attach?: (ydoc) => DocPersistence`
 * callback. Callers typically return the result of `attachIndexedDb(ydoc)`
 * or `attachSqlite(ydoc, { filePath })` directly — both structurally satisfy
 * this type, so no wrapping is needed.
 *
 *   // Browser
 *   attach: (ydoc) => attachIndexedDb(ydoc)
 *
 *   // Desktop / Bun / Tauri
 *   attach: (ydoc) => attachSqlite(ydoc, { filePath })
 *
 *   // In-memory (tests, Node stubs)
 *   // omit `attach`
 *
 * Both fields are required. Every real persistence attachment signals both
 * initial-load readiness and final-teardown settlement; requiring them here
 * catches missing providers at the callback's definition site instead of at
 * runtime. Attachments without async teardown can set
 * `whenDisposed: Promise.resolve()`.
 *
 * This is a *consumer contract*, not a produced attachment — there is no
 * `attachPersistence()` function. Real producers (`attachIndexedDb`,
 * `attachSqlite`) return richer types that structurally satisfy this shape.
 */
export type DocPersistence = {
	whenLoaded: Promise<void>;
	whenDisposed: Promise<void>;
};

/**
 * No-op persistence sentinel — use as a fallback when a content-doc factory
 * is given no `attach` callback (pure in-memory mode):
 *
 *   const persistence = attach?.(ydoc) ?? NO_PERSISTENCE;
 *
 * Both barriers resolve immediately, so `whenReady` / `whenDisposed`
 * aggregations behave correctly even without a real persistence layer.
 */
export const NO_PERSISTENCE: DocPersistence = {
	whenLoaded: Promise.resolve(),
	whenDisposed: Promise.resolve(),
};

/**
 * Contract type for content-doc factory `attach` callbacks.
 *
 * Content-doc factories (`createFileContentDocs`, `createSkillInstructionsDocs`,
 * `createReferenceContentDocs`) accept an `attach?: (ydoc) => ContentAttachment | void`
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
 * `whenLoaded` is required — every real persistence attachment has one, and
 * the factory threads it onto `handle.whenReady`. `whenDisposed` is optional
 * because not every attachment tracks teardown (e.g. a future no-op or
 * in-memory variant), but when present the factory threads it onto the
 * `defineDocument` cache teardown.
 */
export type ContentAttachment = {
	whenLoaded: Promise<void>;
	whenDisposed?: Promise<void>;
};

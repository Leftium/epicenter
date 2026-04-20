/**
 * createDocuments() — runtime document manager factory.
 *
 * Creates a bidirectional link between a table and its associated content Y.Docs.
 * It:
 * 1. Manages Y.Doc creation and provider lifecycle for each content document
 * 2. Watches content documents → calls `onUpdate` callback and writes returned fields to the row
 * 3. Watches the table → automatically cleans up documents when rows are deleted
 *
 * Most users never call this directly — `createWorkspace()` wires it automatically
 * when tables have `.withDocument()` declarations. Advanced users can use it standalone.
 *
 * @example
 * ```typescript
 * import { createDocuments, createTables, defineTable } from '@epicenter/workspace';
 * import * as Y from 'yjs';
 * import { type } from 'arktype';
 *
 * const filesTable = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', {
 *   guid: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 * });
 *
 * const ydoc = new Y.Doc({ guid: 'my-workspace' });
 * const tables = createTables(ydoc, { files: filesTable });
 *
 * const contentDocuments = createDocuments({
 *   id: 'my-workspace',
 *   tableName: 'files',
 *   documentName: 'content',
 *   guidKey: 'id',
 *   onUpdate: () => ({ updatedAt: Date.now() }),
 *   tableHelper: tables.files,
 *   ydoc,
 * });
 *
 * const content = await contentDocuments.open(someRow);
 * content.read();          // read content as string
 * content.write('new content');  // replace content
 * ```
 *
 * @module
 */

import { attachAwareness } from '@epicenter/document';
import * as Y from 'yjs';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	BaseRow,
	ContentHandle,
	ContentStrategy,
	DocumentExtensionRegistration,
	DocumentHandle,
	Documents,
	Table,
} from './types.js';

/**
 * Sentinel symbol used as the Y.js transaction origin when the documents
 * manager writes metadata (e.g., updatedAt) to the table. The update handler
 * checks `origin === DOCUMENTS_ORIGIN` to avoid re-triggering itself.
 *
 * Not part of the public API—internal to the workspace package.
 */
export const DOCUMENTS_ORIGIN = Symbol('documents');

/**
 * Internal entry for an open document.
 *
 * The `handle` field is the public sync accessor — `.get(id)` returns this.
 * It's the strategy's binding spread with framework extras (`whenLoaded`,
 * `ydoc`), so `handle.read()` / `handle.binding` / `handle.whenLoaded` all
 * work on the same object.
 */
type DocEntry<TBinding extends ContentHandle = ContentHandle> = {
	handle: DocumentHandle<TBinding>;
	// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
	extensions: Record<string, Record<string, any>>;
	extensionDisposers: (() => MaybePromise<void>)[];
	unobserve: () => void;
};

/**
 * Configuration for `createDocuments()`.
 *
 * @typeParam TRow - The row type of the bound table
 */
export type CreateDocumentsConfig<
	TRow extends BaseRow,
	TBinding extends ContentHandle = ContentHandle,
> = {
	/**
	 * The workspace identifier. Passed through to `DocumentContext.id`.
	 *
	 * Extensions use this for persistence paths, sync room names, and other
	 * workspace-scoped identifiers. An empty string may cause
	 * collisions or silent failures in extensions.
	 */
	id: string;
	/** The table this document belongs to (e.g., 'files', 'notes'). */
	tableName: string;
	/** The document name from `.withDocument()` (e.g., 'content', 'body'). */
	documentName: string;
	/** Column name storing the Y.Doc GUID. */
	guidKey: keyof TRow & string;
	/** Content strategy — receives the document Y.Doc, returns the content object from `open()`. */
	content: ContentStrategy<TBinding>;
	/**
	 * Fires when the content Y.Doc changes from a local edit. Remote updates
	 * from sync are filtered out inside {@link createDocuments} — see the
	 * `DOCUMENTS_ORIGIN` / Symbol-origin guard in the update observer.
	 *
	 * Return the fields to write to the table row — typically
	 * `{ updatedAt: now() }`. The row write fires `table.observe`, which is
	 * how materializers and other consumers react to content changes.
	 * Return at least one field; `{}` is a silent no-op.
	 */
	onUpdate: () => Partial<Omit<TRow, 'id'>>;
	/** The table helper — needed to write `onUpdate` fields to the row. */
	tableHelper: Table<TRow>;
	/** The workspace Y.Doc — needed for transact() when bumping updatedAt. */
	ydoc: Y.Doc;
	/**
	 * Document extension registrations (from `withDocumentExtension()` calls).
	 * Each registration has a key and factory.
	 */
	documentExtensions?: DocumentExtensionRegistration[];
};


/**
 * Create a runtime documents manager — a bidirectional link between table rows
 * and their content Y.Docs.
 *
 * The manager handles:
 * - Y.Doc creation with `gc: false` (required for Yjs provider compatibility)
 * - Provider lifecycle (persistence, sync) via document extension hooks
 * - Automatic `updatedAt` bumping when content documents change
 *
 * Callers own doc lifecycle on row deletion — call `close(rowOrGuid)` when
 * you delete a row. The manager does not observe the table to auto-close.
 *
 * @param config - Documents configuration
 * @returns A `Documents<TRow>` with open/close/closeAll/guidOf methods
 */
export function createDocuments<
	TRow extends BaseRow,
	TBinding extends ContentHandle = ContentHandle,
>(
	config: CreateDocumentsConfig<TRow, TBinding>,
): Documents<TRow, TBinding> {
	const {
		id,
		tableName,
		documentName,
		guidKey,
		content,
		onUpdate,
		tableHelper,
		ydoc: workspaceYdoc,
		documentExtensions = [],
	} = config;

	const openDocuments = new Map<string, DocEntry<TBinding>>();

	const resolveGuid = (input: TRow | string): string =>
		typeof input === 'string' ? input : String(input[guidKey]);

	/**
	 * Synchronously construct the Y.Doc + binding + extensions for a guid and
	 * stash it in the cache. Subsequent `get()` calls with the same guid hit
	 * the cache.
	 */
	function construct(guid: string): DocEntry<TBinding> {
		const contentYdoc = new Y.Doc({ guid, gc: false });
		// `attachAwareness` constructs a y-protocols Awareness — its constructor
		// self-registers `doc.on('destroy', () => this.destroy())`, so disposal
		// is tied to the Y.Doc automatically. We only need `.raw` here since
		// per-document awareness has no typed field schema.
		const contentAwareness = attachAwareness(contentYdoc, {}).raw;
		const contentBinding = content(contentYdoc);

		// Call document extension factories synchronously.
		// IMPORTANT: No await between openDocuments.get() and openDocuments.set() — ensures
		// concurrent open() calls for the same guid are safe.
		// biome-ignore lint/suspicious/noExplicitAny: runtime storage uses wide type
		const resolvedExtensions: Record<string, Record<string, any>> = {};
		const disposers: (() => MaybePromise<void>)[] = [];
		const initPromises: Promise<unknown>[] = [];

		try {
			for (const { key, factory } of documentExtensions) {
				const ctx = {
					id,
					tableName,
					documentName,
					ydoc: contentYdoc,
					awareness: { raw: contentAwareness },
					init:
						initPromises.length === 0
							? Promise.resolve()
							: Promise.all(initPromises).then(() => {}),
					extensions: { ...resolvedExtensions },
				};
				const raw = factory(ctx);
				if (!raw) continue;

				const { exports, init, dispose } = defineExtension(raw);
				resolvedExtensions[key] = exports;
				disposers.push(dispose);
				initPromises.push(init);
			}
		} catch (err) {
			startDisposeLifo(disposers);
			// ydoc.destroy() auto-destroys the Awareness via doc.on('destroy')
			contentYdoc.destroy();
			throw err;
		}

		// Attach onUpdate observer — fires on LOCAL content doc changes only.
		//
		// When a user types in ProseMirror, this fires and bumps metadata
		// (e.g., updatedAt). That change syncs to other tabs via the workspace
		// Y.Doc. Remote edits arriving via sync/broadcast are skipped — the
		// originating tab already bumped metadata, and we receive it via
		// workspace table sync.
		//
		// Without this guard, every tab independently calls onUpdate() with
		// DateTimeString.now(), producing distinct timestamps that ping-pong
		// between tabs and never converge.
		const updateHandler = (
			_update: Uint8Array,
			origin: unknown,
			_doc: Y.Doc,
			_transaction: Y.Transaction,
		) => {
			// Skip updates from the documents manager itself to avoid loops
			if (origin === DOCUMENTS_ORIGIN) return;

			// Skip transport-originated updates (sync, broadcast channel).
			// Convention: all transport origins are Symbols (SYNC_ORIGIN,
			// BC_ORIGIN). Local edits use non-Symbol origins (e.g., y-prosemirror's
			// ySyncPluginKey is a PluginKey object; direct mutations use null).
			// If a new transport is added, it MUST use a Symbol origin.
			if (typeof origin === 'symbol') return;

			// Call the user's onUpdate callback and write the returned fields
			workspaceYdoc.transact(() => {
				tableHelper.update(guid, onUpdate());
			}, DOCUMENTS_ORIGIN);
		};

		contentYdoc.on('update', updateHandler);
		const unobserve = () => contentYdoc.off('update', updateHandler);

		const whenLoaded: Promise<void> =
			initPromises.length === 0
				? Promise.resolve()
				: Promise.all(initPromises)
						.then(() => {})
						.catch(async (err) => {
							const errors = await disposeLifo(disposers);
							unobserve();
							contentYdoc.destroy();
							openDocuments.delete(guid);
							if (errors.length > 0) {
								console.error('Document extension cleanup errors:', errors);
							}
							throw err;
						});

		// The handle IS the strategy's binding, with framework extras added in-place.
		// We mutate the binding directly (rather than `Object.assign({}, ...)`)
		// because `Object.assign` invokes getters and snapshots the returned value,
		// which would break live getters like Timeline's `currentType`.
		const handle = contentBinding as DocumentHandle<TBinding>;
		Object.defineProperties(handle, {
			whenLoaded: { value: whenLoaded, enumerable: true, configurable: true },
			ydoc: { value: contentYdoc, enumerable: true, configurable: true },
		});

		const entry: DocEntry<TBinding> = {
			handle,
			extensions: resolvedExtensions,
			extensionDisposers: disposers,
			unobserve,
		};
		openDocuments.set(guid, entry);
		return entry;
	}

	async function releaseEntry(entry: DocEntry<TBinding>): Promise<void> {
		entry.unobserve();
		const errors = await disposeLifo(entry.extensionDisposers);
		entry.handle.ydoc.destroy();
		if (errors.length > 0) {
			throw new Error(`Document extension cleanup errors: ${errors.length}`);
		}
	}

	const documents: Documents<TRow, TBinding> = {
		get(input) {
			const guid = resolveGuid(input);
			const existing = openDocuments.get(guid);
			if (existing) return existing.handle;
			return construct(guid).handle;
		},

		async read(input) {
			const handle = documents.get(input);
			await handle.whenLoaded;
			return handle.read();
		},

		async write(input, text) {
			const handle = documents.get(input);
			await handle.whenLoaded;
			handle.write(text);
		},

		async append(input, text) {
			const handle = documents.get(input);
			await handle.whenLoaded;
			// Prefer the strategy's own appendText if it exposes one (Timeline does).
			// Otherwise fall back to read-concat-write — correct for PlainText and
			// RichText, which have no dedicated append primitive.
			if (
				'appendText' in handle &&
				typeof (handle as unknown as { appendText: unknown }).appendText ===
					'function'
			) {
				(handle as unknown as { appendText: (t: string) => void }).appendText(
					text,
				);
			} else {
				handle.write(handle.read() + text);
			}
		},

		async open(input) {
			const handle = documents.get(input);
			await handle.whenLoaded;
			return handle;
		},

		async close(input) {
			const guid = resolveGuid(input);
			const entry = openDocuments.get(guid);
			if (!entry) return;
			// Remove from map SYNCHRONOUSLY so concurrent get() calls
			// create a fresh Y.Doc. Async cleanup follows.
			openDocuments.delete(guid);
			await releaseEntry(entry);
		},

		async closeAll() {
			const entries = Array.from(openDocuments.values());
			openDocuments.clear();
			for (const entry of entries) {
				try {
					await releaseEntry(entry);
				} catch (err) {
					console.error('Document extension cleanup error:', err);
				}
			}
		},
	};

	return documents;
}

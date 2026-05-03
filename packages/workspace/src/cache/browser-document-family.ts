import type * as Y from 'yjs';
import type { SyncControl } from '../document/attach-sync.js';
import {
	createDisposableCache,
	type DisposableCache,
} from './disposable-cache.js';

/**
 * Minimum lifecycle shape every live browser-backed document satisfies.
 *
 * `sync` is the document's own attached sync (or `null` for local-only
 * docs). Rich subtypes narrow it to `SyncAttachment`. The family reads
 * this single field; there is no aliased `syncControl` field on a live
 * document.
 *
 * Storage cleanup is intentionally not on this contract: the family asks
 * `BrowserDocumentFamilySource.clearLocalData()` to reset every child document
 * after pausing sync, so a per-instance method has no caller. Direct one-off
 * consumers can call `doc.idb.clearLocal()` or `doc.persistence?.clearLocal()`
 * on the attachment field they already have.
 */
export type BrowserDocumentInstance = Disposable & {
	ydoc: Y.Doc;
	sync: SyncControl | null;
};

/**
 * Keyed source of possible browser documents. The family owns live document
 * identity and sync pausing. The source owns how to build one live document
 * and how to clear every child document's local storage without constructing
 * them.
 *
 * `clearLocalData()` is the single cleanup path: the family pauses active
 * child sync first, then delegates the storage policy back to the source.
 */
export type BrowserDocumentFamilySource<
	Id extends string | number,
	TDocument extends BrowserDocumentInstance,
> = {
	create(id: Id): TDocument;
	clearLocalData(): Promise<void>;
};

export type BrowserDocumentFamilyOptions = {
	/**
	 * Grace window after the last handle disposes before a document's
	 * cache entry is evicted. A subsequent `open(id)` within this window
	 * reuses the existing live instance instead of building a new one.
	 */
	gcTime?: number;
};

export type DocumentFamily<
	Id extends string | number = string,
	TDocument extends Disposable = Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
};

export type BrowserDocumentFamily<
	Id extends string | number = string,
	TDocument extends BrowserDocumentInstance = BrowserDocumentInstance,
> = DocumentFamily<Id, TDocument> & {
	readonly syncControl: SyncControl;
	clearLocalData(): Promise<void>;
};

export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends BrowserDocumentInstance,
>(
	source: BrowserDocumentFamilySource<Id, TDocument>,
	{ gcTime }: BrowserDocumentFamilyOptions = {},
): BrowserDocumentFamily<Id, TDocument> {
	const activeSyncControls = new Set<SyncControl>();
	const cache: DisposableCache<Id, TDocument> = createDisposableCache(
		(id) => {
			const document = source.create(id);
			const { sync } = document;

			if (sync !== null) {
				activeSyncControls.add(sync);
			}

			return {
				...document,
				[Symbol.dispose]() {
					if (sync !== null) {
						activeSyncControls.delete(sync);
					}
					document[Symbol.dispose]();
				},
			};
		},
		{ gcTime },
	);

	return {
		open(id: Id) {
			return cache.open(id);
		},
		has(id: Id) {
			return cache.has(id);
		},
		/**
		 * Composed control surface that fans `pause()`/`reconnect()` out to
		 * the sync of every currently-open child. Always non-null; safe to
		 * call when no children are open (no-op).
		 */
		syncControl: {
			pause() {
				for (const control of activeSyncControls) control.pause();
			},
			reconnect() {
				for (const control of activeSyncControls) control.reconnect();
			},
		},
		/**
		 * Reset child storage through the source after pausing active child sync
		 * to prevent remote updates from repopulating storage mid-reset.
		 */
		async clearLocalData() {
			for (const control of activeSyncControls) control.pause();
			await source.clearLocalData();
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}

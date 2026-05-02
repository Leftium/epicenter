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
 * docs). Rich subtypes narrow it to `SyncAttachment`. The cache reads
 * this single field; there is no aliased `syncControl` field on a live
 * document.
 *
 * Storage cleanup is intentionally not on this contract: the cache
 * resets through `BrowserDocSource.clearLocalData(id)` for every id
 * (active and unopened) after pausing sync, so a per-instance method has
 * no caller. Direct one-off consumers can call `doc.idb.clearLocal()` or
 * `doc.persistence?.clearLocal()` on the attachment field they already
 * have.
 */
export type BrowserDocInstance = Disposable & {
	ydoc: Y.Doc;
	sync: SyncControl | null;
};

/**
 * Keyed source of possible browser documents. The source owns three
 * operations across all documents of one type: list every id that
 * reset should clear, build a live document for one id, and clear one
 * id's storage by deterministic guid without constructing the document.
 *
 * `clearLocalData(id)` is the single cleanup path: the cache pauses
 * active child sync first, then calls this for every id. Active and
 * unopened ids are handled uniformly.
 */
export type BrowserDocSource<
	Id extends string | number,
	TDocument extends BrowserDocInstance,
> = {
	ids(): Iterable<Id>;
	create(id: Id): TDocument;
	clearLocalData(id: Id): Promise<void>;
};

export type BrowserDocCacheOptions = {
	/**
	 * Grace window after the last handle disposes before a document's
	 * cache entry is evicted. A subsequent `open(id)` within this window
	 * reuses the existing live instance instead of building a new one.
	 */
	gcTime?: number;
};

export type BrowserDocCache<
	Id extends string | number = string,
	TDocument extends BrowserDocInstance = BrowserDocInstance,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	/**
	 * Composed control surface that fans `pause()`/`reconnect()` out to
	 * the sync of every currently-open child. Always non-null; safe to
	 * call when no children are open (no-op).
	 */
	syncControl: SyncControl;
	/**
	 * Reset every id known to the document source. Pauses active child sync
	 * first to prevent remote updates from repopulating storage mid-reset,
	 * then clears each id's storage by deterministic guid.
	 */
	clearLocalData(): Promise<void>;
};

export function createBrowserDocCache<
	Id extends string | number,
	TDocument extends BrowserDocInstance,
>(
	source: BrowserDocSource<Id, TDocument>,
	{ gcTime }: BrowserDocCacheOptions = {},
): BrowserDocCache<Id, TDocument> {
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
		open(id) {
			return cache.open(id);
		},
		has(id) {
			return cache.has(id);
		},
		syncControl: {
			pause() {
				for (const control of activeSyncControls) control.pause();
			},
			reconnect() {
				for (const control of activeSyncControls) control.reconnect();
			},
		},
		async clearLocalData() {
			for (const control of activeSyncControls) control.pause();
			await Promise.all(
				Array.from(source.ids(), (id) => source.clearLocalData(id)),
			);
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}

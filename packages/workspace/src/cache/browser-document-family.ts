import { createDisposableCache } from './disposable-cache.js';

/**
 * Keyed source of possible browser documents. The family owns live document
 * identity. The source owns how to build one live document and how to clear
 * every child document's local storage without constructing them.
 */
export type BrowserDocumentFamilySource<
	Id extends string | number,
	TDocument extends Disposable,
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
	open(id: Id): TDocument;
	has(id: Id): boolean;
};

export type BrowserDocumentFamily<
	Id extends string | number = string,
	TDocument extends Disposable = Disposable,
> = DocumentFamily<Id, TDocument> & {
	clearLocalData(): Promise<void>;
};

export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends Disposable,
>(
	source: BrowserDocumentFamilySource<Id, TDocument>,
	{ gcTime }: BrowserDocumentFamilyOptions = {},
): BrowserDocumentFamily<Id, TDocument> {
	const cache = createDisposableCache<Id, TDocument>(
		(id) => source.create(id),
		{ gcTime },
	);

	return {
		open(id: Id) {
			return cache.open(id);
		},
		has(id: Id) {
			return cache.has(id);
		},
		async clearLocalData() {
			await source.clearLocalData();
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}

import { clearDocument } from 'y-indexeddb';
import type { SyncAttachment } from '../document/attach-sync.js';
import {
	createDisposableCache,
	type DisposableCache,
} from './disposable-cache.js';

export type BrowserDocumentCollection<
	Id extends string | number = string,
	TDocument extends Disposable = Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	pause(): void;
	reconnect(): void;
	clearLocalData(): Promise<void>;
};

export type BrowserDocumentCollectionOptions<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	ids(): Iterable<Id>;
	guid(id: Id): string;
	build(id: Id): TDocument;
	sync?(document: TDocument): SyncAttachment | null;
	clearLocalDataForGuid?(guid: string): Promise<void>;
	gcTime?: number;
};

export function createBrowserDocumentCollection<
	Id extends string | number,
	TDocument extends Disposable,
>({
	ids,
	guid,
	build,
	sync,
	clearLocalDataForGuid = clearDocument,
	gcTime,
}: BrowserDocumentCollectionOptions<
	Id,
	TDocument
>): BrowserDocumentCollection<Id, TDocument> {
	const activeSyncs = new Set<SyncAttachment>();
	const cache: DisposableCache<Id, TDocument> = createDisposableCache(
		(id) => {
			const document = build(id);
			const documentSync = sync?.(document) ?? null;
			if (documentSync !== null) activeSyncs.add(documentSync);

			return {
				...document,
				[Symbol.dispose]() {
					if (documentSync !== null) activeSyncs.delete(documentSync);
					document[Symbol.dispose]();
				},
			};
		},
		{ gcTime },
	);

	return {
		open: (id) => cache.open(id),
		has: (id) => cache.has(id),
		pause() {
			for (const documentSync of activeSyncs) documentSync.pause();
		},
		reconnect() {
			for (const documentSync of activeSyncs) documentSync.reconnect();
		},
		async clearLocalData() {
			this.pause();

			await Promise.all(
				Array.from(ids(), (id) => clearLocalDataForGuid(guid(id))),
			);
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}

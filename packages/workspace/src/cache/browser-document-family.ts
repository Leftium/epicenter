import type { SyncControl } from '../document/attach-sync.js';
import {
	createDisposableCache,
	type DisposableCache,
} from './disposable-cache.js';

export type BrowserDocumentFamilyMember<TDocument extends Disposable> = {
	document: TDocument;
	syncControl: SyncControl | null;
};

export type BrowserDocumentFamily<
	Id extends string | number = string,
	TDocument extends Disposable = Disposable,
> = Disposable & {
	open(id: Id): TDocument & Disposable;
	has(id: Id): boolean;
	syncControl: SyncControl;
	clearLocalData(): Promise<void>;
};

export type BrowserDocumentFamilyOptions<
	Id extends string | number,
	TDocument extends Disposable,
> = {
	create(id: Id): BrowserDocumentFamilyMember<TDocument>;
	clearLocalData(): Promise<void>;
	gcTime?: number;
};

export function createBrowserDocumentFamily<
	Id extends string | number,
	TDocument extends Disposable,
>({
	create,
	clearLocalData: clearFamilyLocalData,
	gcTime,
}: BrowserDocumentFamilyOptions<Id, TDocument>): BrowserDocumentFamily<
	Id,
	TDocument
> {
	const activeSyncControls = new Set<SyncControl>();
	const cache: DisposableCache<Id, TDocument> = createDisposableCache(
		(id) => {
			const { document, syncControl } = create(id);
			const documentSyncControl = syncControl;
			if (documentSyncControl !== null) {
				activeSyncControls.add(documentSyncControl);
			}

			return {
				...document,
				[Symbol.dispose]() {
					if (documentSyncControl !== null) {
						activeSyncControls.delete(documentSyncControl);
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
			await clearFamilyLocalData();
		},
		[Symbol.dispose]() {
			cache[Symbol.dispose]();
		},
	};
}

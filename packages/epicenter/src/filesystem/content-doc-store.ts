import * as Y from 'yjs';
import type { ProviderFactory } from '../dynamic/provider-types.js';
import { defineExports, type Lifecycle } from '../shared/lifecycle.js';
import type { ContentDocStore, FileId } from './types.js';

type DocEntry = {
	ydoc: Y.Doc;
	providers: Lifecycle[];
	whenReady: Promise<Y.Doc>;
};

/**
 * Create a content doc store with optional provider factories for persistence/sync.
 *
 * Provider factories run synchronously when a doc is first ensured. Async initialization
 * (e.g. IndexedDB load) is tracked via each provider's `whenSynced` promise — `ensure()`
 * awaits all of them before returning the hydrated doc.
 *
 * No providers = instant resolution (tests, headless).
 */
export function createContentDocStore(
	providerFactories: ProviderFactory[] = [],
): ContentDocStore {
	const docs = new Map<FileId, DocEntry>();

	return {
		ensure(fileId: FileId): Promise<Y.Doc> {
			const existing = docs.get(fileId);
			if (existing) return existing.whenReady;

			const ydoc = new Y.Doc({ guid: fileId, gc: false });

			// Factories are synchronous; async init tracked via whenSynced
			const providers: Lifecycle[] = [];
			try {
				for (const factory of providerFactories) {
					const result = factory({ ydoc });
					providers.push(result);
				}
			} catch (err) {
				for (const p of providers) p.destroy();
				ydoc.destroy();
				throw err;
			}

			const whenReady =
				providers.length === 0
					? Promise.resolve(ydoc)
					: Promise.all(providers.map((p) => p.whenSynced)).then(() => ydoc);

			docs.set(fileId, { ydoc, providers, whenReady });
			return whenReady;
		},

		async destroy(fileId: FileId): Promise<void> {
			const entry = docs.get(fileId);
			if (!entry) return;
			await Promise.allSettled(entry.providers.map((p) => p.destroy()));
			entry.ydoc.destroy();
			docs.delete(fileId);
		},

		async destroyAll(): Promise<void> {
			const entries = Array.from(docs.values());
			await Promise.allSettled(
				entries.flatMap((e) => e.providers.map((p) => p.destroy())),
			);
			for (const entry of entries) entry.ydoc.destroy();
			docs.clear();
		},
	};
}

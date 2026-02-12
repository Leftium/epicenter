import type { ProviderFactory } from '../dynamic/provider-types.js';
import { createContentDocStore } from './content-doc-store.js';
import {
	getCurrentEntry,
	getEntryMode,
	getTimeline,
	pushBinaryEntry,
	pushTextEntry,
	readEntryAsBuffer,
	readEntryAsString,
} from './timeline-helpers.js';
import type { ContentDocStore, FileId } from './types.js';

/**
 * Content I/O operations for a virtual filesystem.
 *
 * Wraps the `ensure → timeline → transact` pattern that handles
 * mode-aware reads and writes (text vs binary) on per-file Y.Docs.
 * Has no knowledge of file metadata — only content.
 */
export class ContentOps {
	private store: ContentDocStore;

	constructor(providers?: ProviderFactory[]) {
		this.store = createContentDocStore(providers);
	}

	/** Read file content as a string. Returns empty string for empty files. */
	async read(fileId: FileId): Promise<string> {
		const ydoc = await this.store.ensure(fileId);
		const entry = getCurrentEntry(getTimeline(ydoc));
		if (!entry) return '';
		return readEntryAsString(entry);
	}

	/** Read file content as a Uint8Array. Returns empty array for empty files. */
	async readBuffer(fileId: FileId): Promise<Uint8Array> {
		const ydoc = await this.store.ensure(fileId);
		const entry = getCurrentEntry(getTimeline(ydoc));
		if (!entry) return new Uint8Array();
		return readEntryAsBuffer(entry);
	}

	/**
	 * Write data to a file, handling mode switching.
	 * Returns the byte size of the written data.
	 */
	async write(
		fileId: FileId,
		data: string | Uint8Array,
	): Promise<number> {
		const ydoc = await this.store.ensure(fileId);
		const timeline = getTimeline(ydoc);
		const current = getCurrentEntry(timeline);

		if (typeof data === 'string') {
			if (current && getEntryMode(current) === 'text') {
				const ytext = current.get('content') as import('yjs').Text;
				ydoc.transact(() => {
					ytext.delete(0, ytext.length);
					ytext.insert(0, data);
				});
			} else {
				ydoc.transact(() => pushTextEntry(timeline, data));
			}
			return new TextEncoder().encode(data).byteLength;
		} else {
			ydoc.transact(() => pushBinaryEntry(timeline, data));
			return data.byteLength;
		}
	}

	/**
	 * Append text to a file's content, handling mode switching.
	 * Returns the new total byte size of the file content.
	 *
	 * - Text entry: incremental Y.Text insert (timeline doesn't grow)
	 * - Binary entry: decode + concat + push new text entry
	 * - No entry: returns null (caller should use write instead)
	 */
	async append(
		fileId: FileId,
		data: string,
	): Promise<number | null> {
		const ydoc = await this.store.ensure(fileId);
		const timeline = getTimeline(ydoc);
		const current = getCurrentEntry(timeline);

		if (current && getEntryMode(current) === 'text') {
			const ytext = current.get('content') as import('yjs').Text;
			ydoc.transact(() => ytext.insert(ytext.length, data));
		} else if (current && getEntryMode(current) === 'binary') {
			const existing = new TextDecoder().decode(
				current.get('content') as Uint8Array,
			);
			ydoc.transact(() => pushTextEntry(timeline, existing + data));
		} else {
			return null;
		}

		const updatedEntry = getCurrentEntry(timeline)!;
		if (getEntryMode(updatedEntry) === 'text') {
			return new TextEncoder().encode(
				(updatedEntry.get('content') as import('yjs').Text).toString(),
			).byteLength;
		}
		return (updatedEntry.get('content') as Uint8Array).byteLength;
	}

	/** Destroy a specific file's content doc. */
	async destroy(fileId: FileId): Promise<void> {
		return this.store.destroy(fileId);
	}

	/** Destroy all content docs. */
	async destroyAll(): Promise<void> {
		return this.store.destroyAll();
	}
}

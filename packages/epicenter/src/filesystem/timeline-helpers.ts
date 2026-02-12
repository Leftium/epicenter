import * as Y from 'yjs';
import type { ContentMode } from './types.js';

export type Timeline = {
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The most recent entry, or undefined if empty. O(1). */
	readonly currentEntry: Y.Map<any> | undefined;
	/** Content mode of the current entry, or undefined if empty. */
	readonly currentMode: ContentMode | undefined;
	/** Append a new text entry. Returns the Y.Map. */
	pushText(content: string): Y.Map<any>;
	/** Append a new binary entry. Returns the Y.Map. */
	pushBinary(data: Uint8Array): Y.Map<any>;
	/** Read the current entry as a string. Returns '' if empty. */
	readAsString(): string;
	/** Read the current entry as Uint8Array. Returns empty array if empty. */
	readAsBuffer(): Uint8Array;
};

export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<Y.Map<any>>('timeline');

	function currentEntry(): Y.Map<any> | undefined {
		if (timeline.length === 0) return undefined;
		return timeline.get(timeline.length - 1);
	}

	function currentMode(): ContentMode | undefined {
		const entry = currentEntry();
		return entry ? (entry.get('type') as ContentMode) : undefined;
	}

	return {
		get length() {
			return timeline.length;
		},
		get currentEntry() {
			return currentEntry();
		},
		get currentMode() {
			return currentMode();
		},

		pushText(content: string): Y.Map<any> {
			const entry = new Y.Map();
			entry.set('type', 'text');
			const ytext = new Y.Text();
			ytext.insert(0, content);
			entry.set('content', ytext);
			timeline.push([entry]);
			return entry;
		},

		pushBinary(data: Uint8Array): Y.Map<any> {
			const entry = new Y.Map();
			entry.set('type', 'binary');
			entry.set('content', data);
			timeline.push([entry]);
			return entry;
		},

		readAsString(): string {
			const entry = currentEntry();
			if (!entry) return '';
			switch (entry.get('type') as ContentMode) {
				case 'text':
					return (entry.get('content') as Y.Text).toString();
				case 'richtext':
					return '';
				case 'binary':
					return new TextDecoder().decode(
						entry.get('content') as Uint8Array,
					);
			}
		},

		readAsBuffer(): Uint8Array {
			const entry = currentEntry();
			if (!entry) return new Uint8Array();
			switch (entry.get('type') as ContentMode) {
				case 'text':
					return new TextEncoder().encode(
						(entry.get('content') as Y.Text).toString(),
					);
				case 'richtext':
					return new Uint8Array();
				case 'binary':
					return entry.get('content') as Uint8Array;
			}
		},
	};
}

import * as Y from 'yjs';
import type { ContentMode } from './entry-types.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet-csv.js';

type TimelineEntry = Y.Map<unknown>;

export type Timeline = {
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The most recent entry, or undefined if empty. O(1). */
	readonly currentEntry: TimelineEntry | undefined;
	/** Content mode of the current entry, or undefined if empty. */
	readonly currentMode: ContentMode | undefined;
	/** Append a new text entry. Returns the Y.Map. */
	pushText(content: string): TimelineEntry;
	/** Append a new empty sheet entry. Returns the Y.Map. */
	pushSheet(): TimelineEntry;
	/** Append a sheet entry populated from a CSV string. Returns the Y.Map. */
	pushSheetFromCsv(csv: string): TimelineEntry;
	/** Read the current entry as a string. Returns '' if empty. */
	readAsString(): string;
	/** Read the current entry as Uint8Array. Returns empty array if empty. */
	readAsBuffer(): Uint8Array;
};

export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<TimelineEntry>('timeline');

	function currentEntry(): TimelineEntry | undefined {
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

		pushText(content: string): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'text');
			const ytext = new Y.Text();
			ytext.insert(0, content);
			entry.set('content', ytext);
			timeline.push([entry]);
			return entry;
		},

		pushSheet(): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			entry.set('columns', new Y.Map());
			entry.set('rows', new Y.Map());
			timeline.push([entry]);
			return entry;
		},

		pushSheetFromCsv(csv: string): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			const columns = new Y.Map<Y.Map<string>>();
			const rows = new Y.Map<Y.Map<string>>();
			entry.set('columns', columns);
			entry.set('rows', rows);
			parseSheetFromCsv(csv, columns, rows);
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
				case 'sheet':
					return serializeSheetToCsv(
						entry.get('columns') as Y.Map<Y.Map<string>>,
						entry.get('rows') as Y.Map<Y.Map<string>>,
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
				case 'sheet':
					return new TextEncoder().encode(
						serializeSheetToCsv(
							entry.get('columns') as Y.Map<Y.Map<string>>,
							entry.get('rows') as Y.Map<Y.Map<string>>,
						),
					);
			}
		},
	};
}

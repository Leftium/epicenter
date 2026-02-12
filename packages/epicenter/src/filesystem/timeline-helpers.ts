import * as Y from 'yjs';
import type { ContentMode } from './types.js';

/** Get the timeline array from a content doc. */
export function getTimeline(ydoc: Y.Doc): Y.Array<Y.Map<any>> {
	return ydoc.getArray('timeline');
}

/** Get the current (last) entry from a timeline. O(1). */
export function getCurrentEntry(timeline: Y.Array<Y.Map<any>>): Y.Map<any> | undefined {
	if (timeline.length === 0) return undefined;
	return timeline.get(timeline.length - 1);
}

/** Get the content mode of an entry. */
export function getEntryMode(entry: Y.Map<any>): ContentMode {
	return entry.get('type') as ContentMode;
}

/** Create and append a new text entry. Returns the new Y.Map. */
export function pushTextEntry(timeline: Y.Array<Y.Map<any>>, content: string): Y.Map<any> {
	const entry = new Y.Map();
	entry.set('type', 'text');
	const ytext = new Y.Text();
	ytext.insert(0, content);
	entry.set('content', ytext);
	timeline.push([entry]);
	return entry;
}

/** Create and append a new binary entry. Returns the new Y.Map. */
export function pushBinaryEntry(timeline: Y.Array<Y.Map<any>>, data: Uint8Array): Y.Map<any> {
	const entry = new Y.Map();
	entry.set('type', 'binary');
	entry.set('content', data);
	timeline.push([entry]);
	return entry;
}

/** Create and append a new richtext entry. Returns the new Y.Map. */
export function pushRichTextEntry(timeline: Y.Array<Y.Map<any>>, _markdown: string): Y.Map<any> {
	const entry = new Y.Map();
	entry.set('type', 'richtext');
	entry.set('content', new Y.XmlFragment());
	entry.set('frontmatter', new Y.Map());
	timeline.push([entry]);
	return entry;
}

/** Read an entry's content as a string (for readFile). */
export function readEntryAsString(entry: Y.Map<any>): string {
	switch (getEntryMode(entry)) {
		case 'text':
			return (entry.get('content') as Y.Text).toString();
		case 'richtext':
			// Phase 4: serializeXmlFragmentToMarkdown + serializeMarkdownWithFrontmatter
			return '';
		case 'binary':
			return new TextDecoder().decode(entry.get('content') as Uint8Array);
	}
}

/** Read an entry's content as Uint8Array (for readFileBuffer). */
export function readEntryAsBuffer(entry: Y.Map<any>): Uint8Array {
	switch (getEntryMode(entry)) {
		case 'text':
			return new TextEncoder().encode((entry.get('content') as Y.Text).toString());
		case 'richtext':
			// Phase 4: serialize markdown then encode
			return new Uint8Array();
		case 'binary':
			return entry.get('content') as Uint8Array;
	}
}

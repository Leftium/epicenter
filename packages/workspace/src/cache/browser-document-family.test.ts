/**
 * Browser Document Family Tests
 *
 * Verifies the browser document family owns child document identity, refcounted
 * disposal, and source-owned local persistence cleanup.
 *
 * Key behaviors:
 * - Opening the same id deduplicates documents through createDisposableCache.
 * - The family exposes cache identity operations without knowing document sync.
 * - clearLocalData delegates storage cleanup to the source.
 * - Family disposal flushes cached documents.
 */

import { expect, test } from 'bun:test';
import {
	type BrowserDocumentFamilySource,
	createBrowserDocumentFamily,
} from './browser-document-family.js';

type TestDocument = Disposable & {
	id: string;
	value: { text: string };
};

function makeTestDocument(
	id: string,
	onDispose: (id: string) => void = () => {},
): TestDocument {
	return {
		id,
		value: { text: id },
		[Symbol.dispose]() {
			onDispose(id);
		},
	};
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test('open deduplicates documents through createDisposableCache', () => {
	let builds = 0;
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create(id) {
			builds++;
			return makeTestDocument(id);
		},
		clearLocalData: async () => {},
	};
	const family = createBrowserDocumentFamily(source, {
		gcTime: Number.POSITIVE_INFINITY,
	});

	const first = family.open('a');
	const second = family.open('a');

	expect(first).not.toBe(second);
	expect(first.id).toBe(second.id);
	expect(first.value).toBe(second.value);
	expect(builds).toBe(1);
});

test('has returns true while a document is cached', async () => {
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create: (id) => makeTestDocument(id),
		clearLocalData: async () => {},
	};
	const family = createBrowserDocumentFamily(source, { gcTime: 1 });

	const handle = family.open('a');
	expect(family.has('a')).toBe(true);
	handle[Symbol.dispose]();
	await wait(5);

	expect(family.has('a')).toBe(false);
});

test('refcounted handles dispose the document after the last handle exits', async () => {
	const disposed: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create: (id) =>
			makeTestDocument(id, (disposedId) => disposed.push(disposedId)),
		clearLocalData: async () => {},
	};
	const family = createBrowserDocumentFamily(source, { gcTime: 1 });

	const first = family.open('a');
	const second = family.open('a');
	first[Symbol.dispose]();
	await wait(5);
	expect(disposed).toEqual([]);
	second[Symbol.dispose]();
	await wait(5);

	expect(disposed).toEqual(['a']);
});

test('family disposal disposes active cached documents', () => {
	const disposed: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create: (id) =>
			makeTestDocument(id, (disposedId) => disposed.push(disposedId)),
		clearLocalData: async () => {},
	};
	const family = createBrowserDocumentFamily(source, {
		gcTime: Number.POSITIVE_INFINITY,
	});

	family.open('a');
	family.open('b');
	family[Symbol.dispose]();

	expect(disposed.sort()).toEqual(['a', 'b']);
});

test('clearLocalData delegates storage cleanup to source.clearLocalData()', async () => {
	let cleared = false;
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create: (id) => makeTestDocument(id),
		clearLocalData: async () => {
			cleared = true;
		},
	};
	const family = createBrowserDocumentFamily(source);

	await family.clearLocalData();

	expect(cleared).toBe(true);
});

test('source-owned clearLocalData can clear unopened ids without constructing them', async () => {
	const created: string[] = [];
	const cleared: string[] = [];
	const source: BrowserDocumentFamilySource<string, TestDocument> = {
		create: (id) => {
			created.push(id);
			return makeTestDocument(id);
		},
		clearLocalData: async () => {
			cleared.push('open', 'unopened');
		},
	};
	const family = createBrowserDocumentFamily(source);

	const handle = family.open('open');
	await family.clearLocalData();
	handle[Symbol.dispose]();

	expect(created).toEqual(['open']);
	expect(cleared.sort()).toEqual(['open', 'unopened']);
});

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { attachPlainText } from './attach-plain-text.js';

describe('attachPlainText', () => {
	test('reserves the default "content" key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachPlainText(ydoc);

		expect(binding).toBe(ydoc.getText('content'));
	});

	test('honors a custom key', () => {
		const ydoc = new Y.Doc();
		const { binding } = attachPlainText(ydoc, 'code');

		expect(binding).toBe(ydoc.getText('code'));
	});

	test('read() returns the current text', () => {
		const ydoc = new Y.Doc();
		const { binding, read } = attachPlainText(ydoc);
		binding.insert(0, 'hello world');

		expect(read()).toBe('hello world');
	});

	test('read() returns empty string when fresh', () => {
		const ydoc = new Y.Doc();
		const { read } = attachPlainText(ydoc);

		expect(read()).toBe('');
	});

	test('write() replaces content atomically', () => {
		const ydoc = new Y.Doc();
		const { read, write, binding } = attachPlainText(ydoc);
		binding.insert(0, 'old');

		let txCount = 0;
		ydoc.on('afterTransaction', () => {
			txCount++;
		});

		write('new text');

		expect(read()).toBe('new text');
		// Single transaction covers delete+insert; no intermediate empty state visible.
		expect(txCount).toBe(1);
	});

	test('repeat attach on same (ydoc, key) throws — reentrance is rejected', () => {
		const ydoc = new Y.Doc();
		attachPlainText(ydoc, 'content');
		expect(() => attachPlainText(ydoc, 'content')).toThrow(/content/);
	});

	test('different keys on the same ydoc produce different bindings', () => {
		const ydoc = new Y.Doc();
		const a = attachPlainText(ydoc, 'a');
		const b = attachPlainText(ydoc, 'b');

		expect(a.binding).not.toBe(b.binding);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// attachPlainText — reentrance guard (TDD: failing before Phase 3 lands)
// ════════════════════════════════════════════════════════════════════════════

describe('attachPlainText — reentrance guard', () => {
	test('second attach to same (ydoc, key) throws with a clear message naming the key', () => {
		const ydoc = new Y.Doc({ guid: 'attach-plain-text-reentrance' });
		attachPlainText(ydoc, 'notes');

		expect(() => attachPlainText(ydoc, 'notes')).toThrow(/notes/);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-plain-text-destroy-reattach' });
		attachPlainText(ydoc, 'notes');
		ydoc.destroy();

		expect(() => attachPlainText(ydoc, 'notes')).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-plain-text-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-plain-text-doc-b' });
		attachPlainText(docA, 'notes');

		expect(() => attachPlainText(docB, 'notes')).not.toThrow();
	});

	test('different keys on the same Y.Doc do not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-plain-text-different-keys' });
		attachPlainText(ydoc, 'a');

		expect(() => attachPlainText(ydoc, 'b')).not.toThrow();
	});

	test('silent-data-loss scenario is loud: second attach throws BEFORE any mutation on the second wrapper', () => {
		const ydoc = new Y.Doc({ guid: 'attach-plain-text-loud' });
		const first = attachPlainText(ydoc, 'notes');
		first.write('hello from first');

		let secondWrapperReached = false;
		expect(() => {
			const second = attachPlainText(ydoc, 'notes');
			secondWrapperReached = true;
			second.write('clobbered!');
		}).toThrow(/notes/);

		expect(secondWrapperReached).toBe(false);
		expect(first.read()).toBe('hello from first');
	});
});

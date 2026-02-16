import { describe, expect, test } from 'bun:test';
import { ContentOps } from './content-ops.js';
import { createTimeline } from './timeline-helpers.js';
import { generateFileId } from './types.js';

function setup() {
	return new ContentOps();
}

describe('ContentOps', () => {
	describe('read', () => {
		test('empty file returns empty string', async () => {
			const content = setup();
			const id = generateFileId();
			expect(await content.read(id)).toBe('');
		});

		test('reads written text', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'hello world');
			expect(await content.read(id)).toBe('hello world');
		});

		test('reads binary data as decoded string', async () => {
			const content = setup();
			const id = generateFileId();
			const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
			await content.write(id, data);
			expect(await content.read(id)).toBe('Hello');
		});
	});

	describe('readBuffer', () => {
		test('empty file returns empty Uint8Array', async () => {
			const content = setup();
			const id = generateFileId();
			expect(await content.readBuffer(id)).toEqual(new Uint8Array());
		});

		test('reads text as encoded bytes', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'hello');
			expect(await content.readBuffer(id)).toEqual(
				new TextEncoder().encode('hello'),
			);
		});

		test('reads binary data as-is', async () => {
			const content = setup();
			const id = generateFileId();
			const data = new Uint8Array([0xff, 0xfe, 0xfd]);
			await content.write(id, data);
			expect(await content.readBuffer(id)).toEqual(data);
		});
	});

	describe('write', () => {
		test('text write returns byte size', async () => {
			const content = setup();
			const id = generateFileId();
			const size = await content.write(id, 'hello');
			expect(size).toBe(5);
		});

		test('unicode text returns correct byte size', async () => {
			const content = setup();
			const id = generateFileId();
			const size = await content.write(id, '\u{1F600}'); // emoji is 4 bytes in UTF-8
			expect(size).toBe(4);
		});

		test('binary write returns byte size', async () => {
			const content = setup();
			const id = generateFileId();
			const data = new Uint8Array([1, 2, 3, 4]);
			const size = await content.write(id, data);
			expect(size).toBe(4);
		});

		test('text overwrite reuses same timeline entry', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'first');
			await content.write(id, 'second');
			await content.write(id, 'third');
			expect(await content.read(id)).toBe('third');

			// Verify timeline didn't grow
			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(1);
		});

		test('binary write always pushes new entry', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, new Uint8Array([1]));
			await content.write(id, new Uint8Array([2]));
			await content.write(id, new Uint8Array([3]));

			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(3);
		});
	});

	describe('mode switching', () => {
		test('text → binary → text', async () => {
			const content = setup();
			const id = generateFileId();

			await content.write(id, 'hello');
			expect(await content.read(id)).toBe('hello');

			const binary = new Uint8Array([0xde, 0xad]);
			await content.write(id, binary);
			expect(await content.readBuffer(id)).toEqual(binary);

			await content.write(id, 'back to text');
			expect(await content.read(id)).toBe('back to text');

			// Should have 3 timeline entries
			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(3);
		});

		test('binary → text pushes new entry', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, new Uint8Array([1, 2, 3]));
			await content.write(id, 'now text');
			expect(await content.read(id)).toBe('now text');

			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(2);
		});
	});

	describe('append', () => {
		test('append to text entry', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'hello');
			const size = await content.append(id, ' world');
			expect(await content.read(id)).toBe('hello world');
			expect(size).toBe(new TextEncoder().encode('hello world').byteLength);

			// Should not grow timeline
			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(1);
		});

		test('append to binary entry decodes and pushes text', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, new Uint8Array([0x48, 0x69])); // "Hi"
			const size = await content.append(id, ' there');
			expect(await content.read(id)).toBe('Hi there');
			expect(size).toBe(new TextEncoder().encode('Hi there').byteLength);

			// Binary append pushes a new text entry
			const ydoc = await (content as any).store.ensure(id);
			expect(createTimeline(ydoc).length).toBe(2);
		});

		test('append on empty file returns null', async () => {
			const content = setup();
			const id = generateFileId();
			const result = await content.append(id, 'data');
			expect(result).toBeNull();
		});

		test('multiple appends accumulate', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'line1\n');
			await content.append(id, 'line2\n');
			await content.append(id, 'line3\n');
			expect(await content.read(id)).toBe('line1\nline2\nline3\n');
		});
	});

	describe('destroy', () => {
		test('destroy cleans up file doc', async () => {
			const content = setup();
			const id = generateFileId();
			await content.write(id, 'hello');
			await content.destroy(id);
			// After destroy, a new ensure creates a fresh doc
			expect(await content.read(id)).toBe('');
		});

		test('destroy on non-existent file is no-op', async () => {
			const content = setup();
			const id = generateFileId();
			await content.destroy(id); // should not throw
		});
	});

	describe('destroyAll', () => {
		test('destroys all content docs', async () => {
			const content = setup();
			const id1 = generateFileId();
			const id2 = generateFileId();
			await content.write(id1, 'a');
			await content.write(id2, 'b');
			await content.destroyAll();
			expect(await content.read(id1)).toBe('');
			expect(await content.read(id2)).toBe('');
		});
	});

	describe('sheet mode', () => {
		test('read returns CSV for sheet entry', async () => {
			const content = setup();
			const id = generateFileId();
			// Push a sheet entry via timeline
			const ydoc = await (content as any).store.ensure(id);
			const { createTimeline } = await import('./timeline-helpers.js');
			const tl = createTimeline(ydoc);
			ydoc.transact(() => tl.pushSheetFromCsv('Name,Age\nAlice,30\nBob,25\n'));
			expect(await content.read(id)).toBe('Name,Age\nAlice,30\nBob,25\n');
		});

		test('write CSV to sheet-mode file re-parses in place', async () => {
			const content = setup();
			const id = generateFileId();
			const ydoc = await (content as any).store.ensure(id);
			const { createTimeline } = await import('./timeline-helpers.js');
			const tl = createTimeline(ydoc);
			ydoc.transact(() => tl.pushSheetFromCsv('A,B\n1,2\n'));
			await content.write(id, 'X,Y\n3,4\n');
			expect(await content.read(id)).toBe('X,Y\n3,4\n');
			// Timeline should NOT grow (same-mode write)
			expect(createTimeline(ydoc).length).toBe(1);
		});

		test('write CSV to sheet-mode returns byte size', async () => {
			const content = setup();
			const id = generateFileId();
			const ydoc = await (content as any).store.ensure(id);
			const { createTimeline } = await import('./timeline-helpers.js');
			ydoc.transact(() => createTimeline(ydoc).pushSheetFromCsv('A\n1\n'));
			const size = await content.write(id, 'X,Y\n3,4\n');
			expect(size).toBe(new TextEncoder().encode('X,Y\n3,4\n').byteLength);
		});

		test('binary write on sheet-mode file mode-switches', async () => {
			const content = setup();
			const id = generateFileId();
			const ydoc = await (content as any).store.ensure(id);
			const { createTimeline } = await import('./timeline-helpers.js');
			ydoc.transact(() => createTimeline(ydoc).pushSheetFromCsv('A\n1\n'));
			await content.write(id, new Uint8Array([0xde, 0xad]));
			expect(createTimeline(ydoc).length).toBe(2);
			expect(createTimeline(ydoc).currentMode).toBe('binary');
		});
	});
});

/**
 * Peer-mode detail rendering — regression for the manifest-out-of-awareness
 * refactor. Peer manifests are fetched once via
 * `peerSystem(sync, deviceId).describe()`; detail mode renders directly
 * from that fetched manifest with no second RTT, and `printActionDetail`
 * is now sync.
 */

import { describe, expect, test } from 'bun:test';
import type { ActionMeta } from '@epicenter/workspace';
import Type from 'typebox';
import { printActionDetail } from '../src/commands/list';

function captureStdout(fn: () => void): string {
	const original = console.log;
	const lines: string[] = [];
	console.log = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(' '));
	};
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines.join('\n');
}

describe('printActionDetail — peer source', () => {
	test('renders the input fields section from a fetched ActionMeta', () => {
		const meta: ActionMeta = {
			type: 'mutation',
			description: 'Close one or more browser tabs',
			input: Type.Object({
				tabIds: Type.Array(Type.Number(), {
					description: 'Tab IDs to close',
				}),
			}),
		};

		const out = captureStdout(() => printActionDetail('tabs.close', meta));

		expect(out).toContain('tabs.close  (mutation)');
		expect(out).toContain('Close one or more browser tabs');
		expect(out).toContain('Input fields (pass as JSON):');
		expect(out).toContain('tabIds');
	});
});

describe('printActionDetail — local source', () => {
	test('renders input directly from the entry', () => {
		const local: ActionMeta = {
			type: 'query',
			description: 'Read counter',
			input: Type.Object({ key: Type.String() }),
		};

		const out = captureStdout(() => printActionDetail('counter.get', local));

		expect(out).toContain('counter.get  (query)');
		expect(out).toContain('Read counter');
		expect(out).toContain('key: string  (required)');
	});
});

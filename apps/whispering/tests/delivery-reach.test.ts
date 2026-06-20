import { describe, expect, test } from 'bun:test';
import { reachForCursorWrite } from '../src/lib/operations/delivery-reach';

/**
 * Locks the reach policy for a cursor write (ADR-0030). The reach is decided from
 * where `write_text` reports the transcript landed, never from observing the
 * keystroke, so the only mapping that matters is outcome -> reach.
 */
describe('reachForCursorWrite', () => {
	test('a pasted write reached the configured output', () => {
		expect(reachForCursorWrite('pasted')).toBe('output');
	});

	test('a clipboard fallback is a reduced reach', () => {
		expect(reachForCursorWrite('leftOnClipboard')).toBe('clipboard');
	});
});

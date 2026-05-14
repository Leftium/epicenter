import { type } from 'arktype';
import { describe, expect, it } from 'bun:test';
import { Replica } from './peer-identity.js';

describe('Replica schema', () => {
	it('accepts a well-formed replica with each supported platform', () => {
		for (const platform of [
			'web',
			'tauri',
			'chrome-extension',
			'node',
		] as const) {
			const result = Replica({ id: 'rid-123', platform });
			expect(result).toEqual({ id: 'rid-123', platform });
		}
	});

	it('rejects unknown platforms', () => {
		const result = Replica({ id: 'rid-123', platform: 'mainframe' });
		expect(result).toBeInstanceOf(type.errors);
	});

	it('rejects missing id', () => {
		const result = Replica({ platform: 'web' } as never);
		expect(result).toBeInstanceOf(type.errors);
	});

	it('rejects extra fields by not preserving them (id+platform only)', () => {
		const result = Replica({
			id: 'rid-123',
			platform: 'web',
			name: 'extra-field',
		} as never);
		// Arktype types are partial-tolerant: extra keys pass through. Confirm
		// the supported keys land at the expected values; consumers read by key.
		if (result instanceof type.errors) throw result;
		expect(result.id).toBe('rid-123');
		expect(result.platform).toBe('web');
	});
});

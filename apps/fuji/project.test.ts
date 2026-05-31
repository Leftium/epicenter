import { describe, expect, test } from 'bun:test';

import { fuji } from './project.js';

describe('fuji project entry point', () => {
	test('exports the project mount factory from the app root', () => {
		const mount = fuji();

		expect(mount.name).toBe('fuji');
		expect(mount.open).toBeFunction();
	});
});

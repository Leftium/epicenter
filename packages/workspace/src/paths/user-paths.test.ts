import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';

import {
	userCacheDir,
	userConfigDir,
	userDataDir,
	userLogDir,
} from './user-paths.js';

describe('user paths', () => {
	test('uses platform absolute paths for every user path', () => {
		expect(isAbsolute(userConfigDir)).toBe(true);
		expect(isAbsolute(userDataDir)).toBe(true);
		expect(isAbsolute(userCacheDir)).toBe(true);
		expect(isAbsolute(userLogDir)).toBe(true);
	});

	test('uses the plain epicenter app name without the env-paths nodejs suffix', () => {
		for (const path of [userConfigDir, userDataDir, userCacheDir, userLogDir]) {
			expect(path).toContain('epicenter');
			expect(path).not.toContain('epicenter-nodejs');
		}
	});
});

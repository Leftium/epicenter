import {
	afterEach,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EPICENTER_API_URL } from '@epicenter/constants/apps';

import {
	__resetApiUrlLogStateForTests,
	resolveApiEndpoint,
} from './api-url.js';

const ENV_KEY = 'EPICENTER_API_URL';

let savedEnv: string | undefined;

beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	__resetApiUrlLogStateForTests();
});

afterEach(() => {
	if (savedEnv === undefined) {
		delete process.env[ENV_KEY];
	} else {
		process.env[ENV_KEY] = savedEnv;
	}
	__resetApiUrlLogStateForTests();
});

describe('resolveApiEndpoint baseURL', () => {
	test('returns the prod constant when the env var is unset', () => {
		expect(resolveApiEndpoint().baseURL).toBe(EPICENTER_API_URL);
	});

	test('returns the env var value when set to a valid URL', () => {
		process.env[ENV_KEY] = 'http://localhost:8787';
		expect(resolveApiEndpoint().baseURL).toBe('http://localhost:8787');
	});

	test('strips a single trailing slash from the env var value', () => {
		process.env[ENV_KEY] = 'http://localhost:8787/';
		expect(resolveApiEndpoint().baseURL).toBe('http://localhost:8787');
	});

	test('throws naming the offending value when the env var is malformed', () => {
		process.env[ENV_KEY] = 'not a url';
		expect(() => resolveApiEndpoint()).toThrow(/not a url/);
	});
});

describe('resolveApiEndpoint filePath', () => {
	test('returns ~/.epicenter/auth.json for the prod host', () => {
		expect(resolveApiEndpoint().filePath).toBe(
			join(homedir(), '.epicenter', 'auth.json'),
		);
	});

	test('returns auth.<host>.json with `:` replaced for a host with a port', () => {
		process.env[ENV_KEY] = 'http://localhost:8787';
		expect(resolveApiEndpoint().filePath).toBe(
			join(homedir(), '.epicenter', 'auth.localhost_8787.json'),
		);
	});

	test('returns auth.<host>.json for a host without a port', () => {
		process.env[ENV_KEY] = 'https://staging.epicenter.so';
		expect(resolveApiEndpoint().filePath).toBe(
			join(homedir(), '.epicenter', 'auth.staging.epicenter.so.json'),
		);
	});
});

describe('resolveApiEndpoint stderr emission', () => {
	test('writes one line on the first call when the env var is set, nothing on the second', () => {
		process.env[ENV_KEY] = 'http://localhost:8787';
		const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			resolveApiEndpoint();
			resolveApiEndpoint();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(
				'Using API at http://localhost:8787.\n',
			);
		} finally {
			spy.mockRestore();
		}
	});

	test('writes nothing when the env var is unset', () => {
		const spy = spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			resolveApiEndpoint();
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});

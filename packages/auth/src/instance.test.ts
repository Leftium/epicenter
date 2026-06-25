import { describe, expect, test } from 'bun:test';
import { normalizeInstanceUrl } from './instance.js';

describe('normalizeInstanceUrl', () => {
	test('defaults a missing scheme to https', () => {
		const { data } = normalizeInstanceUrl('epicenter.example.com');
		expect(data).toBe('https://epicenter.example.com');
	});

	test('preserves an explicit http scheme (localhost self-host)', () => {
		const { data } = normalizeInstanceUrl('http://localhost:8788');
		expect(data).toBe('http://localhost:8788');
	});

	test('strips a trailing slash, query, and hash', () => {
		const { data } = normalizeInstanceUrl('https://host.example.com/?a=1#x');
		expect(data).toBe('https://host.example.com');
	});

	test('preserves a path prefix', () => {
		const { data } = normalizeInstanceUrl('https://host.example.com/epicenter/');
		expect(data).toBe('https://host.example.com/epicenter');
	});

	test('rejects empty input', () => {
		const { data, error } = normalizeInstanceUrl('   ');
		expect(data).toBeNull();
		expect(error?.name).toBe('InvalidUrl');
	});

	test('rejects a non-http(s) scheme', () => {
		const { error } = normalizeInstanceUrl('ftp://host.example.com');
		expect(error?.name).toBe('InvalidUrl');
	});
});

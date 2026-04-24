/**
 * Parse Input Tests
 *
 * These tests verify how CLI JSON input is sourced and parsed across positional
 * values (inline JSON or `@file.json`) and stdin. They protect input precedence
 * and error messaging so command handlers receive the intended payload.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ParseInputOptions, parseJsonInput } from './parse-input.js';

describe('parseJsonInput', () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'parse-input-test-'));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('parses inline JSON', () => {
		const result = parseJsonInput<{ id: string; name: string }>({
			positional: '{"id":"1","name":"test"}',
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ id: '1', name: 'test' });
	});

	test('reads @file shorthand', () => {
		const filePath = join(tempDir, 'test.json');
		writeFileSync(filePath, '{"id":"2","value":42}');

		const result = parseJsonInput<{ id: string; value: number }>({
			positional: `@${filePath}`,
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ id: '2', value: 42 });
	});

	test('reads stdin content', () => {
		const result = parseJsonInput<{ from: string }>({
			stdinContent: '{"from":"stdin"}',
		});

		expect(result.error).toBeNull();
		expect(result.data).toEqual({ from: 'stdin' });
	});

	test('returns error for invalid JSON', () => {
		const result = parseJsonInput({ positional: '{invalid json}' });

		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain('Invalid JSON');
	});

	test('returns error for missing @file', () => {
		const result = parseJsonInput({
			positional: '@/nonexistent/path/file.json',
		});

		expect(result.error).toBeDefined();
		expect(result.error?.message).toContain('File not found');
	});

	test('returns Ok(undefined) when no input provided', () => {
		const result = parseJsonInput({} satisfies ParseInputOptions);

		expect(result.error).toBeNull();
		expect(result.data).toBeUndefined();
	});

	test('prioritizes positional over stdin', () => {
		const result = parseJsonInput<{ source: string }>({
			positional: '{"source":"positional"}',
			stdinContent: '{"source":"stdin"}',
		});

		expect(result.error).toBeNull();
		expect(result.data!.source).toBe('positional');
	});
});

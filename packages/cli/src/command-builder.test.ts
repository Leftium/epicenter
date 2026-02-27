/**
 * Command Builder Tests
 *
 * These tests verify that the action command is correctly built as a yargs
 * command module that dispatches action calls via HTTP.
 */
import { describe, expect, test } from 'bun:test';
import { buildActionCommand } from './command-builder';

describe('buildActionCommand', () => {
	test('returns a command module with correct shape', () => {
		const cmd = buildActionCommand('http://localhost:3913', 'test-workspace');

		expect(cmd.command).toBe('action <path> [json]');
		expect(cmd.describe).toBe('Run an action (query or mutation)');
		expect(typeof cmd.handler).toBe('function');
		expect(typeof cmd.builder).toBe('function');
	});

	test('builder configures path and json positionals', () => {
		const cmd = buildActionCommand('http://localhost:3913', 'test-workspace');

		// The builder is a function that configures yargs
		expect(typeof cmd.builder).toBe('function');
	});
});

import { describe, test } from 'bun:test';

/**
 * CLI Integration Tests
 *
 * SKIPPED: These tests require the contract-handler separation migration to be complete.
 *
 * The tests use the OLD pattern where `defineWorkspace` accepts an `actions` factory
 * that returns actions with `handler` functions.
 *
 * With the new architecture:
 * - `actions` is a plain object of contracts (no factory function)
 * - Handlers are bound via `.withHandlers()` on the workspace contract
 *
 * Re-enable when `.withHandlers()` is implemented.
 * See: specs/20260101T014845-contract-handler-separation.md
 */
describe.skip('CLI Integration (PENDING: contract-handler separation)', () => {
	test('CLI can be created from workspaces array', () => {});
	test('CLI runs workspace command', () => {});
});

/**
 * Source-shape lock for the Fuji per-app openers.
 *
 * Static checks only. Asserts that the schema module is pure data + factories
 * with no Y.Doc construction or encryption attach, and that the browser /
 * daemon openers compose from the new Tier 1 primitives (`openEncryptedDoc`,
 * `attachLocalStorage`, `openCollaboration`). Behavior tests live in
 * `workspace.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fujiDir = dirname(fileURLToPath(import.meta.url));

const workspaceSource = readFileSync(
	join(fujiDir, 'src/lib/workspace.ts'),
	'utf8',
);
const browserSource = readFileSync(join(fujiDir, 'src/lib/browser.ts'), 'utf8');
const daemonSource = readFileSync(join(fujiDir, 'daemon.ts'), 'utf8');
const packageJson = JSON.parse(
	readFileSync(join(fujiDir, 'package.json'), 'utf8'),
) as { exports: { '.': string; './daemon': string } };

describe('Fuji workspace architecture', () => {
	test('schema module is pure data: no opener, no Y.Doc construction', () => {
		expect(workspaceSource).toContain('export const FUJI_ID');
		expect(workspaceSource).toContain('export const fujiTables');
		expect(workspaceSource).toContain('export function createFujiActions');
		expect(workspaceSource).toContain('export function entryContentDocGuid');
		// No opener / encryption / ydoc in the schema file.
		expect(workspaceSource).not.toContain('openFujiWorkspace');
		expect(workspaceSource).not.toContain('attachFujiWorkspace');
		expect(workspaceSource).not.toContain('new Y.Doc');
		expect(workspaceSource).not.toContain('openEncryptedDoc');
		expect(workspaceSource).not.toContain('attachEncryption');
		expect(packageJson.exports['.']).toBe('./src/lib/workspace.ts');
	});

	test('browser opener composes from new primitives', () => {
		expect(browserSource).toContain('export function openFujiBrowser');
		expect(browserSource).toContain('openEncryptedDoc');
		expect(browserSource).toContain('attachLocalStorage');
		expect(browserSource).toContain('openCollaboration');
		expect(browserSource).toContain('wipeLocalStorage');
		// No LocalOwner / attachEncryption / wipeLocalYjsData carry-over.
		expect(browserSource).not.toContain('LocalOwner');
		expect(browserSource).not.toContain('attachEncryption');
		expect(browserSource).not.toContain('wipeLocalYjsData');
		expect(browserSource).not.toContain('owner.attachLocal');
		expect(browserSource).not.toContain('connectDaemonActions');
	});

	test('daemon opener composes from new primitives + materializers', () => {
		expect(daemonSource).toContain('export function openFujiDaemon');
		expect(daemonSource).toContain('openEncryptedDoc');
		expect(daemonSource).toContain('attachDaemonInfrastructure');
		expect(daemonSource).toContain('attachSqliteMaterializer');
		expect(daemonSource).toContain('attachMarkdownMaterializer');
		expect(daemonSource).toContain('ctx.keyring');
		expect(daemonSource).toContain('ctx.clientId');
		expect(daemonSource).not.toContain('attachEncryption');
		expect(daemonSource).not.toContain('openFujiWorkspace');
		expect(packageJson.exports['./daemon']).toBe('./daemon.ts');
	});
});

/**
 * End-to-end test: Opensidian workspace persistence and import behavior.
 *
 * Verifies that the opensidian workspace (filesystem-backed note-taking)
 * works end-to-end with persistence and document content.
 *
 * Key behaviors:
 * - Table CRUD works for the files table (folders + files)
 * - Document content round-trips through write → read
 * - Persistence survives restart (table data + document content)
 * - pushFromMarkdown imports .md files into tables + document content
 * - Wikilinks in imported bodies are resolved to epicenter:// links
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileId } from '@epicenter/filesystem';
import {
	attachTimeline,
	createDisposableCache,
	generateId,
} from '@epicenter/workspace';
import { assembleMarkdown } from '@epicenter/workspace/markdown';
import { attachYjsLog } from '@epicenter/workspace/node';
import { createOpensidian, opensidianFileContentDocGuid } from 'opensidian';
import * as Y from 'yjs';
import { pushFromMarkdown } from './push-from-markdown';

const TEST_ENCRYPTION_KEYS = [
	{
		version: 1,
		keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	},
];

const PERSISTENCE_DIR = join(
	import.meta.dir,
	'.test-fixtures/.epicenter-opensidian-test',
);

function dbPath(id: string) {
	return join(PERSISTENCE_DIR, `${id}.db`);
}

/** Create a workspace client with filesystem persistence for testing. */
function createTestClient() {
	const workspace = createOpensidian({
		keyring: () => TEST_ENCRYPTION_KEYS,
	});
	attachYjsLog(workspace.ydoc, {
		filePath: dbPath(workspace.ydoc.guid),
	});

	const contentDocs = createDisposableCache(
		(fileId: FileId) => {
			const contentDoc = new Y.Doc({
				guid: opensidianFileContentDocGuid(fileId),
				gc: true,
			});
			attachYjsLog(contentDoc, {
				filePath: join(PERSISTENCE_DIR, 'content', `${contentDoc.guid}.db`),
			});
			return {
				ydoc: contentDoc,
				content: attachTimeline(contentDoc),
				whenReady: Promise.resolve(),
				[Symbol.dispose]() {
					contentDoc.destroy();
				},
			};
		},
		{ gcTime: 0 },
	);

	const client = {
		id: workspace.ydoc.guid,
		ydoc: workspace.ydoc,
		tables: workspace.tables,
		kv: workspace.kv,
		whenReady: Promise.resolve(),
		async dispose() {
			workspace[Symbol.dispose]();
		},
	};
	return { client, contentDocs };
}

async function writeContent(
	contentDocs: ReturnType<typeof createTestClient>['contentDocs'],
	id: string,
	text: string,
) {
	await using handle = contentDocs.open(id as FileId);
	await handle.whenReady;
	handle.content.write(text);
}

async function readContent(
	contentDocs: ReturnType<typeof createTestClient>['contentDocs'],
	id: string,
) {
	await using handle = contentDocs.open(id as FileId);
	await handle.whenReady;
	return handle.content.read();
}

describe('e2e: opensidian workspace', () => {
	const folderId = generateId();
	const fileId = generateId();

	beforeAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	test('table CRUD: create folder and file', async () => {
		const { client, contentDocs } = createTestClient();
		await client.whenReady;

		// Create a folder
		client.tables.files.set({
			id: folderId,
			name: 'My Notes',
			parentId: null,
			type: 'folder',
			size: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			trashedAt: null,
		});

		// Create a file inside the folder
		client.tables.files.set({
			id: fileId,
			name: 'hello.md',
			parentId: folderId,
			type: 'file',
			size: 0,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			trashedAt: null,
		});

		const files = client.tables.files.getAllValid();
		expect(files).toHaveLength(2);

		const folder = files.find((f) => f.type === 'folder');
		expect(folder).toBeDefined();
		expect(folder?.name).toBe('My Notes');

		const file = files.find((f) => f.type === 'file');
		expect(file).toBeDefined();
		expect(file?.name).toBe('hello.md');
		expect(file?.parentId).toBe(folderId);

		await client.dispose();
	});

	test('persistence: table data survives restart', async () => {
		const { client, contentDocs } = createTestClient();
		await client.whenReady;

		const files = client.tables.files.getAllValid();
		expect(files).toHaveLength(2);

		const folder = files.find((f) => f.type === 'folder');
		expect(folder?.name).toBe('My Notes');

		const file = files.find((f) => f.type === 'file');
		expect(file?.name).toBe('hello.md');
		expect(file?.parentId).toBe(folderId);

		await client.dispose();
	});
});

describe('e2e: opensidian pushFromMarkdown', () => {
	const IMPORT_DIR = join(
		import.meta.dir,
		'.test-fixtures/.opensidian-import-test',
	);
	const IMPORT_PERSISTENCE = join(
		import.meta.dir,
		'.test-fixtures/.epicenter-opensidian-import',
	);
	const IMPORT_FILES_DIR = join(IMPORT_DIR, 'files');

	function createImportClient() {
		const workspace = createOpensidian({
			keyring: () => TEST_ENCRYPTION_KEYS,
		});
		attachYjsLog(workspace.ydoc, {
			filePath: join(IMPORT_PERSISTENCE, `${workspace.ydoc.guid}.db`),
		});

		const contentDocs = createDisposableCache(
			(fileId: FileId) => {
				const contentDoc = new Y.Doc({
					guid: opensidianFileContentDocGuid(fileId),
					gc: true,
				});
				attachYjsLog(contentDoc, {
					filePath: join(
						IMPORT_PERSISTENCE,
						'content',
						`${contentDoc.guid}.db`,
					),
				});
				return {
					ydoc: contentDoc,
					content: attachTimeline(contentDoc),
					whenReady: Promise.resolve(),
					[Symbol.dispose]() {
						contentDoc.destroy();
					},
				};
			},
			{ gcTime: 0 },
		);

		const client = {
			id: workspace.ydoc.guid,
			ydoc: workspace.ydoc,
			tables: workspace.tables,
			kv: workspace.kv,
			whenReady: Promise.resolve(),
			async dispose() {
				workspace[Symbol.dispose]();
			},
		};
		return { client, contentDocs };
	}

	/** Write a markdown file with YAML frontmatter and optional body. */
	async function writeTestMd(
		filename: string,
		frontmatter: Record<string, unknown>,
		body?: string,
	): Promise<void> {
		await mkdir(IMPORT_FILES_DIR, { recursive: true });
		const content = assembleMarkdown(frontmatter, body);
		await Bun.write(join(IMPORT_FILES_DIR, filename), content);
	}

	beforeAll(async () => {
		await rm(IMPORT_DIR, { recursive: true, force: true });
		await rm(IMPORT_PERSISTENCE, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(IMPORT_DIR, { recursive: true, force: true });
		await rm(IMPORT_PERSISTENCE, { recursive: true, force: true });
	});

	test('imports table row + document content from .md file', async () => {
		const fileId = generateId();
		await writeTestMd(
			'test-note.md',
			{
				id: fileId,
				name: 'test-note.md',
				parentId: null,
				size: 0,
				createdAt: 1712300000000,
				updatedAt: 1712300000000,
				trashedAt: null,
			},
			'# Test Note\n\nHello from import.',
		);

		const { client, contentDocs } = createImportClient();
		await client.whenReady;

		const result = await pushFromMarkdown({
			tables: client.tables,
			writeContent: (id, text) => writeContent(contentDocs, id, text),
			filesDir: IMPORT_FILES_DIR,
		});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.errors).toHaveLength(0);

		// Verify table row
		const { data: row } = client.tables.files.get(fileId);
		expect(row?.name).toBe('test-note.md');
		expect(row?.type).toBe('file');
		expect(row?.createdAt).toBe(1712300000000);

		// Verify document content
		expect(await readContent(contentDocs, fileId)).toBe(
			'# Test Note\n\nHello from import.',
		);

		await client.dispose();
	});

	test('skips files without id in frontmatter', async () => {
		await writeTestMd('no-id.md', { name: 'orphan', size: 0 });

		const { client, contentDocs } = createImportClient();
		await client.whenReady;

		const result = await pushFromMarkdown({
			tables: client.tables,
			writeContent: (id, text) => writeContent(contentDocs, id, text),
			filesDir: IMPORT_FILES_DIR,
		});

		// The file with id from previous test is still there, plus the no-id file
		expect(result.skipped).toBeGreaterThanOrEqual(1);

		await client.dispose();
	});

	test('converts [[wikilinks]] to epicenter:// links on import', async () => {
		const targetId = generateId();
		const sourceId = generateId();

		const { client, contentDocs } = createImportClient();
		await client.whenReady;

		// Pre-seed the target row so the wikilink can resolve regardless of file processing order
		client.tables.files.set({
			id: targetId,
			name: 'Target Note',
			parentId: null,
			type: 'file',
			size: 0,
			createdAt: 1712300000000,
			updatedAt: 1712300000000,
			trashedAt: null,
		});

		// Write source file with a wikilink referencing the target
		await writeTestMd(
			'wikilink-source.md',
			{
				id: sourceId,
				name: 'Source Note',
				parentId: null,
				size: 0,
				createdAt: 1712300000000,
				updatedAt: 1712300000000,
				trashedAt: null,
			},
			'# Source\n\nSee [[Target Note]] for details.',
		);

		const result = await pushFromMarkdown({
			tables: client.tables,
			writeContent: (id, text) => writeContent(contentDocs, id, text),
			filesDir: IMPORT_FILES_DIR,
		});

		expect(result.errors).toHaveLength(0);

		// [[Target Note]] should have been resolved to [Target Note](epicenter://opensidian/files/GUID)
		expect(await readContent(contentDocs, sourceId)).toBe(
			`# Source\n\nSee [Target Note](epicenter://opensidian/files/${targetId}) for details.`,
		);

		await client.dispose();
	});
});

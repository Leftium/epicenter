/**
 * markdown_apply: declarative reconcile tests.
 *
 * apply treats the on-disk file set as the desired state and reconciles it INTO
 * the tables, keyed by row id:
 *   creates = file on disk, no row
 *   updates = row + file disagree
 *   deletes = row exists, file gone
 *
 * These tests prove the design does not lose data:
 * - dryRun computes the plan and writes nothing
 * - a removed file deletes its row (via onDelete; default hard delete)
 * - the delete guard refuses a large deletion and applies nothing
 * - a parse/validation failure refuses the whole run, so a broken file never
 *   lets an unrelated file read as a delete
 * - apply over an unchanged tree is a no-op (round-trip with the materializer)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createWorkspace, DateTimeString, defineTable } from '../../../index.js';
import { column } from '../../column/index.js';
import { attachMarkdownMaterializer } from './materializer.js';

const postsTable = defineTable({
	id: column.string(),
	title: column.string(),
	published: column.boolean(),
});

// Exercises the non-string column types that must round-trip through YAML
// without showing a spurious update: number, nullable, and a json array.
const typedTable = defineTable({
	id: column.string(),
	rating: column.number(),
	archivedAt: column.nullable(column.dateTime()),
	tags: column.json(Type.Array(Type.String())),
});

const tableDefinitions = { posts: postsTable, typed: typedTable };

const TEST_DIR = join(import.meta.dir, '__test-apply__');

beforeEach(async () => {
	await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

async function writePost(id: string, frontmatter: string) {
	await mkdir(join(TEST_DIR, 'posts'), { recursive: true });
	await writeFile(join(TEST_DIR, 'posts', `${id}.md`), frontmatter, 'utf-8');
}

async function removePost(id: string) {
	await unlink(join(TEST_DIR, 'posts', `${id}.md`));
}

const post = (id: string, title: string, published = true) =>
	`---\nid: ${id}\ntitle: ${title}\npublished: ${published}\n---\n`;

type SetupOptions = {
	onDelete?: (id: string) => void;
};

async function setup({ onDelete }: SetupOptions = {}) {
	const workspace = createWorkspace({
		id: 'test-apply',
		tables: tableDefinitions,
		kv: {},
	});
	const materializer = attachMarkdownMaterializer(workspace, {
		dir: TEST_DIR,
		perTable: { posts: { onDelete }, typed: {} },
	});
	await materializer.whenFlushed;
	return { workspace, materializer };
}

describe('markdown_apply', () => {
	test('dryRun computes the plan and writes nothing', async () => {
		const { workspace, materializer } = await setup();
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		workspace.tables.posts.set({ id: 'b', title: 'Beta', published: true });

		// Disk: a unchanged, b edited, c new, (b/c differ from table) -> a is a no-op.
		await materializer.actions.markdown_pull();
		await writePost('b', post('b', 'Beta EDITED'));
		await writePost('c', post('c', 'Gamma NEW'));

		const plan = await materializer.actions.markdown_apply({ dryRun: true });

		expect(plan.refused).toBe(false);
		expect(plan.creates.map((c) => c.id).sort()).toEqual(['c']);
		expect(plan.updates.map((u) => u.id).sort()).toEqual(['b']);
		expect(plan.deletes).toEqual([]);

		// Table is untouched by a dry run.
		expect(workspace.tables.posts.get('b').data?.title).toBe('Beta');
		expect(workspace.tables.posts.has('c')).toBe(false);
	});

	test('applies creates, updates, and deletes', async () => {
		const { workspace, materializer } = await setup();
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		workspace.tables.posts.set({ id: 'b', title: 'Beta', published: true });
		workspace.tables.posts.set({ id: 'c', title: 'Gamma', published: true });
		await materializer.actions.markdown_pull();

		await writePost('b', post('b', 'Beta EDITED')); // update
		await removePost('c'); // delete
		await writePost('d', post('d', 'Delta NEW')); // create

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.refused).toBe(false);
		expect(plan.creates.map((c) => c.id)).toEqual(['d']);
		expect(plan.updates.map((u) => u.id)).toEqual(['b']);
		expect(plan.deletes.map((x) => x.id)).toEqual(['c']);

		expect(workspace.tables.posts.get('a').data?.title).toBe('Alpha'); // untouched
		expect(workspace.tables.posts.get('b').data?.title).toBe('Beta EDITED');
		expect(workspace.tables.posts.get('c').data).toBeNull(); // hard-deleted
		expect(workspace.tables.posts.get('d').data?.title).toBe('Delta NEW');
	});

	test('apply over an unchanged tree is a no-op', async () => {
		const { workspace, materializer } = await setup();
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		workspace.tables.posts.set({ id: 'b', title: 'Beta', published: false });
		await materializer.actions.markdown_pull();

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.creates).toEqual([]);
		expect(plan.updates).toEqual([]);
		expect(plan.deletes).toEqual([]);
		expect(plan.refused).toBe(false);
	});

	test('delete guard refuses a large deletion and applies nothing', async () => {
		const { workspace, materializer } = await setup();
		for (const id of ['a', 'b', 'c']) {
			workspace.tables.posts.set({ id, title: id.toUpperCase(), published: true });
		}
		await materializer.actions.markdown_pull();

		// Remove every file: 3 deletes, but cap at 1.
		await removePost('a');
		await removePost('b');
		await removePost('c');

		const plan = await materializer.actions.markdown_apply({ maxDeletes: 1 });

		expect(plan.refused).toBe(true);
		expect(plan.reason).toContain('deletes');
		expect(plan.deletes).toHaveLength(3);
		// Nothing was applied: all rows survive.
		expect(workspace.tables.posts.count()).toBe(3);
	});

	test('a parse failure refuses the run; no unrelated row is deleted', async () => {
		const { workspace, materializer } = await setup();
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		workspace.tables.posts.set({ id: 'b', title: 'Beta', published: true });
		await materializer.actions.markdown_pull();

		// One file goes invalid (published is not a boolean) and another is removed.
		await writePost('a', `---\nid: a\ntitle: Alpha\npublished: nope\n---\n`);
		await removePost('b');

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.refused).toBe(true);
		expect(plan.errors).toHaveLength(1);
		// The removed file did NOT delete row b, because the run was refused.
		expect(workspace.tables.posts.has('b')).toBe(true);
	});

	test('onDelete hook handles removals instead of hard delete', async () => {
		const softDeleted: string[] = [];
		const { workspace, materializer } = await setup({
			onDelete: (id) => softDeleted.push(id),
		});
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		await materializer.actions.markdown_pull();

		await removePost('a');
		const plan = await materializer.actions.markdown_apply({});

		expect(plan.deletes.map((x) => x.id)).toEqual(['a']);
		expect(softDeleted).toEqual(['a']);
		// The hook ran instead of the default hard delete: the row is still present.
		expect(workspace.tables.posts.has('a')).toBe(true);
	});

	test('applies all writes in a single atomic Yjs transaction', async () => {
		const { workspace, materializer } = await setup();
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		workspace.tables.posts.set({ id: 'b', title: 'Beta', published: true });
		await materializer.actions.markdown_pull();

		await writePost('b', post('b', 'Beta EDITED')); // update
		await removePost('a'); // delete
		await writePost('c', post('c', 'Gamma')); // create

		let updates = 0;
		const onUpdate = () => updates++;
		workspace.ydoc.on('update', onUpdate);
		await materializer.actions.markdown_apply({});
		workspace.ydoc.off('update', onUpdate);

		// Create + update + delete land as ONE update, not three: peers never see
		// a half-applied reconcile.
		expect(updates).toBe(1);
	});

	test('non-string columns round-trip without a spurious update', async () => {
		const { workspace, materializer } = await setup();
		// number, a real datetime, a null, and a json array: the types most
		// likely to drift through YAML and falsely register as edits.
		workspace.tables.typed.set({
			id: 't1',
			rating: 4,
			archivedAt: DateTimeString.now(),
			tags: ['a', 'b'],
		});
		workspace.tables.typed.set({
			id: 't2',
			rating: 0,
			archivedAt: null,
			tags: [],
		});
		await materializer.actions.markdown_pull();

		const plan = await materializer.actions.markdown_apply({ dryRun: true });

		// Materialize then read back is the identity: nothing changed on disk.
		expect(plan.updates).toEqual([]);
		expect(plan.creates).toEqual([]);
		expect(plan.deletes).toEqual([]);
	});

	test('a missing directory does not delete every row', async () => {
		const { workspace, materializer } = await setup();
		for (const id of ['a', 'b', 'c']) {
			workspace.tables.posts.set({ id, title: id, published: true });
		}
		await materializer.actions.markdown_pull();

		// Remove the whole posts directory (e.g. wrong path, unpopulated mount).
		// A missing directory carries no desired state, so it must not read as
		// "delete all three" even though the count is under the guard.
		await rm(join(TEST_DIR, 'posts'), { recursive: true, force: true });

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.refused).toBe(false);
		expect(plan.deletes).toEqual([]);
		expect(workspace.tables.posts.count()).toBe(3);
	});

	test('duplicate ids across files refuse the run', async () => {
		const { workspace, materializer } = await setup();
		await writePost('one', post('one', 'First', true));
		// Two distinct files declaring the same id: the reconcile cannot pick one.
		await writeFile(
			join(TEST_DIR, 'posts', 'duplicate.md'),
			post('one', 'Second', false),
			'utf-8',
		);

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.refused).toBe(true);
		expect(plan.errors).toHaveLength(1);
		expect(workspace.tables.posts.has('one')).toBe(false); // nothing applied
	});

	test('strips unknown frontmatter keys (no smuggled data, no churn)', async () => {
		const { workspace, materializer } = await setup();
		// Extra keys plus a literal __proto__ key: must not reach the stored row
		// and must not pollute the global prototype.
		await writePost(
			'x',
			'---\nid: x\ntitle: T\npublished: true\nsneaky: evil\n__proto__: pwned\n---\n',
		);

		const plan = await materializer.actions.markdown_apply({});
		expect(plan.refused).toBe(false);
		expect(plan.creates.map((c) => c.id)).toEqual(['x']);

		const row = workspace.tables.posts.get('x').data;
		expect(Object.hasOwn(row ?? {}, 'sneaky')).toBe(false);
		expect((Object.prototype as Record<string, unknown>).pwned).toBeUndefined();

		// Re-applying the same dirty file is a no-op: cleaned desired equals stored.
		const again = await materializer.actions.markdown_apply({});
		expect(again.updates).toEqual([]);
		expect(again.creates).toEqual([]);
	});

	test('reads nested filenames so apply does not delete them', async () => {
		// A filename that nests into a subdirectory must round-trip: a flat scan
		// would miss it and apply would wrongly plan a delete.
		const workspace = createWorkspace({
			id: 'test-nested',
			tables: tableDefinitions,
			kv: {},
		});
		const materializer = attachMarkdownMaterializer(workspace, {
			dir: TEST_DIR,
			perTable: { posts: { filename: (r) => `archive/${r.id}.md` } },
		});
		await materializer.whenFlushed;
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		await materializer.actions.markdown_pull(); // writes posts/archive/a.md

		const plan = await materializer.actions.markdown_apply({ dryRun: true });
		expect(plan.refused).toBe(false);
		expect(plan.deletes).toEqual([]);
		expect(plan.updates).toEqual([]);
	});

	test('refuses a table whose toMarkdown has no fromMarkdown', async () => {
		// toMarkdown emits a body, but with no fromMarkdown apply would silently
		// drop it. The guard must refuse before touching anything.
		const workspace = createWorkspace({
			id: 'test-guard',
			tables: tableDefinitions,
			kv: {},
		});
		const materializer = attachMarkdownMaterializer(workspace, {
			dir: TEST_DIR,
			perTable: {
				posts: { toMarkdown: (r) => ({ frontmatter: { ...r }, body: 'prose' }) },
			},
		});
		await materializer.whenFlushed;
		workspace.tables.posts.set({ id: 'a', title: 'Alpha', published: true });
		await materializer.actions.markdown_pull();

		const plan = await materializer.actions.markdown_apply({});

		expect(plan.refused).toBe(true);
		expect((plan.errors[0]?.error as { name?: string })?.name).toBe(
			'RoundTripUnproven',
		);
	});

	test('an empty present directory deletes rows only under the guard', async () => {
		const { workspace, materializer } = await setup();
		for (const id of ['a', 'b', 'c']) {
			workspace.tables.posts.set({ id, title: id, published: true });
		}
		await materializer.actions.markdown_pull();

		// Remove the files but keep the (now empty) posts/ directory: this is a
		// real "delete everything" intent, distinct from a missing directory.
		await removePost('a');
		await removePost('b');
		await removePost('c');

		// maxDeletes:0 is the escape hatch against an accidental empty dir.
		const refused = await materializer.actions.markdown_apply({ maxDeletes: 0 });
		expect(refused.refused).toBe(true);
		expect(workspace.tables.posts.count()).toBe(3);

		// Allowed: an empty present directory does delete all rows.
		const applied = await materializer.actions.markdown_apply({});
		expect(applied.deletes).toHaveLength(3);
		expect(workspace.tables.posts.count()).toBe(0);
	});
});

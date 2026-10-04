/**
 * Experiment: one ordinary directory shared by two applications and an agent.
 *
 * Two definitions with the same `todos` table name, but different declared
 * fields and different KV keys, are opened one after the other over one real
 * temporary directory through the directory entry. Neither names the folder:
 * the directory entry is given its root.
 * An "agent" is plain `node:fs` writes into the same directory: it never goes
 * through a folder handle.
 *
 * Every claim is an assertion against bytes read back from disk with
 * `node:fs`, never against the handle that wrote them. The process exits
 * nonzero when any assertion fails.
 *
 * This establishes shared-file semantics for a directory only. It says
 * nothing about browser storage, the desktop owner, or sync between devices.
 *
 *   bun packages/folder/evidence/shared-folder-workflow.ts
 */
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
	defineFolder,
	defineTable,
	type FolderDefinition,
	field,
	hashBytes,
	openFolder,
} from '@epicenter/folder/bun';
import type { Result } from 'wellcrafted/result';

// Keep the developer's global Git configuration (hooks, signing) out of the
// repository the opener initializes. This changes this process's environment
// only; no configuration file is read or written.
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
});

// ---------------------------------------------------------------------------
// The two applications
// ---------------------------------------------------------------------------

/** App A: a checklist. It knows `title` and `done`. */
const appA = defineFolder({
	kv: {
		theme: field.string(),
		sortBy: field.string(),
		pageSize: field.number(),
	},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const A_KV_DEFAULTS = { theme: 'light', sortBy: 'created', pageSize: 20 };

/** App B: a planner. It knows `title` and `priority`, and nothing of `done`. */
const appB = defineFolder({
	// `pageSize` is declared by both, with different types: a deliberate collision.
	kv: {
		density: field.string(),
		showArchived: field.boolean(),
		pageSize: field.string(),
	},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), priority: field.number() },
		}),
	},
});
const B_KV_DEFAULTS = {
	density: 'comfortable',
	showArchived: false,
	pageSize: 'all',
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function section(title: string) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function note(text: string) {
	console.log(`  · ${text}`);
}

/** Show exact text: escapes make line endings, a BOM, and trailing spaces visible. */
function show(label: string, text: string) {
	console.log(`  ${label}:`);
	for (const line of text.split(/(?<=\n)/))
		console.log(`    │ ${JSON.stringify(line).slice(1, -1)}`);
}

function check(label: string, condition: boolean, detail?: unknown) {
	if (condition) {
		passed += 1;
		console.log(`  ✓ ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  ✗ ${label}`);
	if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
}

function ok<T, E>({ data, error }: Result<T, E>): T {
	if (error !== null)
		throw new Error(`Expected Ok, got ${JSON.stringify(error)}`);
	return data as T;
}

function refusal<T, E>({ data, error }: Result<T, E>): E {
	if (error === null)
		throw new Error(`Expected a refusal, got ${JSON.stringify(data)}`);
	return error;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const author = { name: 'Experiment', email: 'experiment@example.test' };
const encoder = new TextEncoder();
const PREFIX = 'epicenter-shared-folder-workflow-';
const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));

/** Open the shared directory as one application. History stays manual: no commit is part of this experiment. */
async function open<const TDefinition extends FolderDefinition>(
	definition: TDefinition,
) {
	return ok(
		await openFolder({
			root,
			definition,
			git: { author, commitOnEdit: false },
		}),
	);
}

/** The agent's and the assertions' view: the directory through `node:fs`, never through a handle. */
const disk = {
	bytes: (path: string) => readFile(join(root, path)),
	text: async (path: string) =>
		(await readFile(join(root, path))).toString('utf8'),
	exists: (path: string) => existsSync(join(root, path)),
	write: (path: string, content: string | Uint8Array) =>
		writeFile(join(root, path), content),
};

try {
	console.log(`Disposable directory: ${root}`);
	console.log(`Bun ${Bun.version}, ${process.platform}`);

	// -------------------------------------------------------------------------
	section('1. App A creates a row with title, done, and a body');
	// -------------------------------------------------------------------------
	const ROW = 'todos/milk.md';
	const BODY = 'Whole milk, 2 litres.\n\nAsk about the *oat* one too.\n';
	{
		const a = await open(appA);
		const created = ok(
			await a.tables.todos.create({
				stem: 'milk',
				fields: { title: 'Buy milk', done: false },
				body: BODY,
			}),
		);
		await a.close();
		const onDisk = await disk.text(ROW);
		show(ROW, onDisk);
		check(
			'the row is one ordinary Markdown file at todos/milk.md',
			disk.exists(ROW),
		);
		check('the receipt source is the bytes on disk', created.source === onDisk);
		check(
			'the receipt hash is the hash of the bytes on disk',
			created.sha256 === (await hashBytes(await disk.bytes(ROW))),
		);
	}

	// -------------------------------------------------------------------------
	section('2. An agent edits the same file with a text editor');
	// -------------------------------------------------------------------------
	// A comment, a key neither application declares, and a quoting style the
	// folder would not have chosen itself.
	const AGENT_ROW =
		'---\n' +
		'# agent: reviewed 2026-10-02, do not reorder\n' +
		"title: 'Buy milk'   # quoted by hand\n" +
		'done: false\n' +
		'estimate: 15m\n' +
		'---\n' +
		BODY;
	await disk.write(ROW, AGENT_ROW);
	show(ROW, AGENT_ROW);
	note('written with node:fs; no folder handle is open');

	// -------------------------------------------------------------------------
	section('3. App B reads its own schema and adds its own field');
	// -------------------------------------------------------------------------
	{
		const b = await open(appB);
		const listed = ok(await b.tables.todos.list());
		check(
			'B discovers the row A created by listing',
			listed.length === 1 && listed[0]?.path === ROW,
		);
		const row = ok(await b.tables.todos.get('milk'));
		if (row === undefined) throw new Error('B did not find the row');
		check(
			'B reads the title both applications declare',
			row.fields.title === 'Buy milk',
		);
		check(
			"B's fields hold nothing B did not declare (no done, no estimate)",
			Object.keys(row.fields).join() === 'title',
			Object.keys(row.fields),
		);
		check(
			"B's own missing field is an issue, not a parse error",
			row.parseError === undefined &&
				row.issues.length === 1 &&
				row.issues[0]?.field === 'priority',
			row.issues,
		);
		check(
			'B still has the exact source, comment and unknown keys included',
			row.source === AGENT_ROW,
		);
		check('B reads the body exactly', row.body === BODY);

		const updated = ok(
			await b.tables.todos.update('milk', { fields: { priority: 2 } }),
		);
		await b.close();
		const onDisk = await disk.text(ROW);
		show(ROW, onDisk);
		const ADDED = 'priority: 2\n';
		check(
			'the update added exactly one line; every other byte is what the agent wrote',
			onDisk.split(ADDED).length === 2 &&
				onDisk.replace(ADDED, '') === AGENT_ROW,
		);
		check(
			'the body is byte-for-byte unchanged',
			onDisk.endsWith(`---\n${BODY}`),
		);
		check(
			"the receipt is the bytes on disk and now reads B's field",
			updated.source === onDisk && updated.fields.priority === 2,
		);
		check(
			'the update left B with no issues',
			updated.issues.length === 0,
			updated.issues,
		);

		// A second application's value for a field it does not declare is refused.
		const b2 = await open(appB);
		const undeclared = refusal(
			await b2.tables.todos.update('milk', {
				// @ts-expect-error `done` is not a field of B's table.
				fields: { done: true },
			}),
		);
		await b2.close();
		check(
			"B cannot assign A's field through its typed table: InvalidValues, nothing written",
			undeclared.name === 'InvalidValues' && (await disk.text(ROW)) === onDisk,
			undeclared.name,
		);
	}

	// -------------------------------------------------------------------------
	section('4. App A reads again and ticks the checkbox');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		const before = await disk.text(ROW);
		const row = ok(await a.tables.todos.get('milk'));
		if (row === undefined) throw new Error('A did not find the row');
		check(
			'A reads its own two fields and no others',
			row.fields.title === 'Buy milk' &&
				row.fields.done === false &&
				Object.keys(row.fields).sort().join() === 'done,title',
			row.fields,
		);
		check(
			"B's field is not an issue for A",
			row.issues.length === 0,
			row.issues,
		);
		check(
			"A's source still carries B's field and the agent's comment",
			row.source.includes('priority: 2\n') &&
				row.source.includes('# agent: reviewed'),
		);
		check('A reads the same body it wrote', row.body === BODY);

		ok(await a.tables.todos.update('milk', { fields: { done: true } }));
		await a.close();
		const after = await disk.text(ROW);
		show(ROW, after);
		check(
			'ticking the checkbox changed only the value span of done',
			after === before.replace('done: false\n', 'done: true\n') &&
				after !== before,
		);
	}

	// -------------------------------------------------------------------------
	section('5. kv.json is absent until an application explicitly creates it');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		const snapshot = ok(await a.kv.get());
		const effective = { ...A_KV_DEFAULTS, ...(snapshot?.values ?? {}) };
		check(
			'get() on a folder with no kv.json is Ok(undefined)',
			snapshot === undefined,
		);
		check(
			"A's effective settings are entirely its own defaults",
			JSON.stringify(effective) === JSON.stringify(A_KV_DEFAULTS),
			effective,
		);
		const missing = refusal(await a.kv.update({ theme: 'dark' }));
		check(
			'update() on a missing file is NotFound, not an upsert',
			missing.name === 'NotFound',
			missing.name,
		);
		await a.close();
		check(
			'reading, defaulting, a refused update, and closing left no kv.json',
			!disk.exists('kv.json'),
		);

		const b = await open(appB);
		check(
			'opening as B leaves it absent too',
			ok(await b.kv.get()) === undefined && !disk.exists('kv.json'),
		);
		await b.close();
	}
	{
		const a = await open(appA);
		const created = ok(await a.kv.create({ theme: 'dark' }));
		const onDisk = await disk.text('kv.json');
		show('kv.json', onDisk);
		check(
			'create() wrote only the supplied key: the file is sparse, defaults are not saved',
			onDisk === '{\n  "theme": "dark"\n}\n' && created.source === onDisk,
		);
		const again = refusal(await a.kv.create({ theme: 'light' }));
		check(
			'a second create() is Exists and changes nothing',
			again.name === 'Exists' && (await disk.text('kv.json')) === onDisk,
			again.name,
		);
		await a.close();
	}

	// -------------------------------------------------------------------------
	section('6. Divergent KV schemas update only their own keys');
	// -------------------------------------------------------------------------
	// The agent adds a key neither application declares, with a number
	// spelling and spacing a serializer would not reproduce.
	const AGENT_KV = '{\n  "theme": "dark",\n\t"agentBudget":   1.50\n}\n';
	await disk.write('kv.json', AGENT_KV);
	show('kv.json after the agent', AGENT_KV);
	{
		const b = await open(appB);
		const snapshot = ok(await b.kv.get());
		check(
			"B reads none of A's keys or the agent's: values is empty, with no issues",
			snapshot !== undefined &&
				Object.keys(snapshot.values).length === 0 &&
				snapshot.issues.length === 0 &&
				snapshot.parseError === undefined,
			snapshot?.values,
		);
		const effective = { ...B_KV_DEFAULTS, ...(snapshot?.values ?? {}) };
		check(
			"B's effective settings are its own defaults",
			JSON.stringify(effective) === JSON.stringify(B_KV_DEFAULTS),
			effective,
		);

		const undeclared = refusal(
			await b.kv.update(
				// @ts-expect-error `theme` is not a key of B's KV.
				{ theme: 'light' },
			),
		);
		check(
			"B cannot assign A's key: InvalidValues, nothing written",
			undeclared.name === 'InvalidValues' &&
				(await disk.text('kv.json')) === AGENT_KV,
			undeclared.name,
		);

		ok(await b.kv.update({ density: 'compact' }));
		await b.close();
		const onDisk = await disk.text('kv.json');
		show("kv.json after B's update", onDisk);
		const ADDED = ',\n\t"density":   "compact"';
		check(
			"B's update appended one member; A's key and the agent's key are byte-for-byte unchanged",
			onDisk.replace(ADDED, '') === AGENT_KV && onDisk !== AGENT_KV,
		);
	}
	{
		const a = await open(appA);
		const before = await disk.text('kv.json');
		const snapshot = ok(await a.kv.get());
		check(
			"A reads only its own stored key; B's density is not in values",
			JSON.stringify(snapshot?.values) === '{"theme":"dark"}',
			snapshot?.values,
		);
		ok(await a.kv.update({ theme: 'light' }));
		await a.close();
		const after = await disk.text('kv.json');
		show("kv.json after A's update", after);
		check(
			"A's update changed only the value span of theme",
			after === before.replace('"dark"', '"light"') && after !== before,
		);
		check(
			"the agent's number spelling survived both updates",
			after.includes('"agentBudget":   1.50'),
		);
	}

	// -------------------------------------------------------------------------
	section('6b. A key both applications declare, with different types');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		ok(await a.kv.update({ pageSize: 50 }));
		await a.close();
		const before = await disk.text('kv.json');

		const b = await open(appB);
		const snapshot = ok(await b.kv.get());
		check(
			"A's number under a key B declares as a string is a field issue for B, and is left out of B's values",
			snapshot !== undefined &&
				!('pageSize' in snapshot.values) &&
				snapshot.issues.length === 1 &&
				snapshot.issues[0]?.field === 'pageSize',
			snapshot?.issues,
		);
		const effective = { ...B_KV_DEFAULTS, ...(snapshot?.values ?? {}) };
		check(
			'B falls back to its own default for that key',
			effective.pageSize === 'all',
			effective,
		);
		check(
			'reading it changed nothing on disk',
			(await disk.text('kv.json')) === before,
		);
		note(`B's issue: ${snapshot?.issues[0]?.message}`);

		ok(await b.kv.update({ pageSize: 'all' }));
		await b.close();
		const a2 = await open(appA);
		const forA = ok(await a2.kv.get());
		await a2.close();
		check(
			"nothing stops B from saving its own type there: A's stored value is gone and A now has the issue",
			forA !== undefined &&
				!('pageSize' in forA.values) &&
				forA.issues[0]?.field === 'pageSize',
			forA?.issues,
		);
	}

	// -------------------------------------------------------------------------
	section('6c. An agent leaves kv.json as text that is not strict JSON');
	// -------------------------------------------------------------------------
	{
		const good = await disk.text('kv.json');
		// A trailing comma: what a hand edit most often leaves behind.
		const BROKEN = good.replace('\n}\n', ',\n}\n');
		await disk.write('kv.json', BROKEN);
		show('kv.json', BROKEN);

		const a = await open(appA);
		const snapshot = ok(await a.kv.get());
		if (snapshot === undefined) throw new Error('A did not find kv.json');
		check(
			'get() is a snapshot with a parseError, the exact source, and no values',
			snapshot.parseError !== undefined &&
				snapshot.source === BROKEN &&
				Object.keys(snapshot.values).length === 0,
		);
		note(`parseError: ${snapshot.parseError?.message}`);
		const effective = { ...A_KV_DEFAULTS, ...snapshot.values };
		check(
			"A's stored theme is unreadable, so the documented merge silently shows the default",
			effective.theme === A_KV_DEFAULTS.theme && good.includes('"light"'),
			effective,
		);
		const refused = refusal(await a.kv.update({ theme: 'dark' }));
		check(
			'update() is refused as Unparsed and writes nothing',
			refused.name === 'Unparsed' && (await disk.text('kv.json')) === BROKEN,
			refused.name,
		);

		// KV has no replace of its own: repair goes through files, then inspect.
		const capture = ok(await a.files.replace(snapshot, good));
		const reading = a.kv.inspect(good);
		await a.close();
		check(
			'files.replace(snapshot, source) repairs it; the receipt is a bare capture of the bytes on disk',
			(await disk.text('kv.json')) === good &&
				capture.sha256 === (await hashBytes(await disk.bytes('kv.json'))) &&
				Object.keys(capture).sort().join() === 'path,sha256',
			Object.keys(capture),
		);
		check(
			"kv.inspect(source) is the second call that says how the repair reads: A's theme is back",
			reading.parseError === undefined && reading.values.theme === 'light',
			reading.values,
		);
	}

	// -------------------------------------------------------------------------
	section('7. An agent writes a value a declared field does not accept');
	// -------------------------------------------------------------------------
	const INVALID_FIELD =
		'---\ntitle: Buy milk\ndone: maybe\npriority: 2\n---\n' + BODY;
	await disk.write(ROW, INVALID_FIELD);
	show(ROW, INVALID_FIELD);
	{
		const a = await open(appA);
		const row = ok(await a.tables.todos.get('milk'));
		if (row === undefined) throw new Error('A did not find the row');
		check(
			'the text parses: there is no parseError',
			row.parseError === undefined,
		);
		check('the source is available exactly', row.source === INVALID_FIELD);
		check(
			'the healthy field is still available',
			row.fields.title === 'Buy milk',
		);
		check('the body is still available', row.body === BODY);
		check(
			'the invalid field is left out and named by one issue',
			!('done' in row.fields) &&
				row.issues.length === 1 &&
				row.issues[0]?.field === 'done',
			row.issues,
		);
		note(`issue: ${row.issues[0]?.message}`);

		// A structured update of the healthy field is not blocked by the other field's issue.
		const retitled = ok(
			await a.tables.todos.update('milk', {
				fields: { title: 'Buy oat milk' },
			}),
		);
		check(
			"updating the healthy field succeeds and leaves the agent's invalid value in place",
			retitled.source ===
				INVALID_FIELD.replace('title: Buy milk', 'title: Buy oat milk') &&
				retitled.issues[0]?.field === 'done',
		);
		// A structured update is also the repair for one invalid field.
		const repaired = ok(
			await a.tables.todos.update('milk', { fields: { done: false } }),
		);
		check(
			'assigning the invalid field through update repairs it',
			repaired.issues.length === 0 && repaired.fields.done === false,
		);
		await a.close();
	}

	// -------------------------------------------------------------------------
	section('8. An agent writes YAML that does not parse');
	// -------------------------------------------------------------------------
	const MALFORMED = '---\ntitle: [Buy milk\ndone: false\n---\n' + BODY;
	await disk.write(ROW, MALFORMED);
	show(ROW, MALFORMED);
	{
		const a = await open(appA);
		const listed = ok(await a.tables.todos.list());
		check(
			'the row is still listed, as a snapshot and not as an error',
			listed.length === 1 && listed[0]?.result.error === null,
		);
		const row = ok(await a.tables.todos.get('milk'));
		if (row === undefined) throw new Error('A did not find the row');
		check(
			'the snapshot has a parseError with at least one diagnostic',
			row.parseError !== undefined && row.parseError.diagnostics.length >= 1,
		);
		check('the source is available exactly', row.source === MALFORMED);
		check(
			'there are no fields, no body, and no issues',
			Object.keys(row.fields).length === 0 &&
				row.body === undefined &&
				row.issues.length === 0,
		);
		note(`parseError: ${row.parseError?.message}`);

		const refused = refusal(
			await a.tables.todos.update('milk', { fields: { done: true } }),
		);
		check(
			'a structured update is refused as Unparsed and writes nothing',
			refused.name === 'Unparsed' && (await disk.text(ROW)) === MALFORMED,
			refused.name,
		);

		// Repair: complete replacement text against the unparsed snapshot's capture.
		const REPAIRED = MALFORMED.replace('[Buy milk', 'Buy milk');
		check(
			'inspect() says the candidate repair parses, before anything is saved',
			a.tables.todos.inspect(REPAIRED).parseError === undefined,
		);
		const repaired = ok(await a.tables.todos.replace(row, REPAIRED));
		await a.close();
		check(
			'replace(snapshot, source) repairs it: the receipt parses and is the bytes on disk',
			repaired.parseError === undefined &&
				repaired.fields.title === 'Buy milk' &&
				repaired.body === BODY &&
				(await disk.text(ROW)) === REPAIRED,
		);
	}

	// -------------------------------------------------------------------------
	section('9. An agent writes Markdown with no fences at all');
	// -------------------------------------------------------------------------
	const UNFENCED = '# Buy milk\n\nJust a note an agent dropped in.\n';
	await disk.write(ROW, UNFENCED);
	show(ROW, UNFENCED);
	{
		const b = await open(appB);
		const row = ok(await b.tables.todos.get('milk'));
		if (row === undefined) throw new Error('B did not find the row');
		check(
			'the snapshot has a parseError and the exact source',
			row.parseError !== undefined && row.source === UNFENCED,
		);
		check(
			'the text is not read as a body, and nothing inserted fences',
			row.body === undefined && (await disk.text(ROW)) === UNFENCED,
		);
		note(`parseError: ${row.parseError?.message}`);
		const refused = refusal(await b.tables.todos.update('milk', { body: 'x' }));
		check(
			'a body-only update is refused as Unparsed too',
			refused.name === 'Unparsed',
			refused.name,
		);

		// Repair, keeping the agent's text as the body. The application builds the text itself.
		const REPAIRED = `---\ntitle: Buy milk\npriority: 2\n---\n${UNFENCED}`;
		const repaired = ok(await b.tables.todos.replace(row, REPAIRED));
		await b.close();
		check(
			"raw replacement repairs it and keeps the agent's text as the body",
			repaired.parseError === undefined &&
				repaired.body === UNFENCED &&
				(await disk.text(ROW)) === REPAIRED,
		);
		check(
			"B's repair did not write A's field, so A will see an issue for done",
			!repaired.source.includes('done'),
		);
	}
	{
		const a = await open(appA);
		const row = ok(await a.tables.todos.get('milk'));
		ok(await a.tables.todos.update('milk', { fields: { done: false } }));
		await a.close();
		check(
			"A sees its field missing after B's repair, and restores it with one update",
			row?.issues[0]?.field === 'done' &&
				(await disk.text(ROW)).includes('done: false\n'),
		);
	}

	// -------------------------------------------------------------------------
	section('10. A stale capture: the agent edits between read and save');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		let hints = 0;
		const stop = a.onFilesChanged(() => {
			hints += 1;
		});
		const captured = ok(await a.tables.todos.get('milk'));
		if (captured === undefined) throw new Error('A did not find the row');
		const baseline = captured.source;

		// The person in app A edits a draft of the whole text.
		const candidate = baseline.replace(
			'title: Buy milk',
			'title: Buy milk and eggs',
		);

		// Meanwhile the agent appends a line to the body on disk.
		const agentText = `${baseline}\nAgent: the shop closes at 18:00.\n`;
		await disk.write(ROW, agentText);
		check(
			"the directory handle heard no hint for the agent's write",
			hints === 0,
			hints,
		);

		const refused = refusal(await a.tables.todos.replace(captured, candidate));
		stop();
		check(
			'the stale replacement is refused as Conflict',
			refused.name === 'Conflict',
			refused.name,
		);
		if (refused.name !== 'Conflict') throw new Error('Expected Conflict');
		const diskBytes = await disk.bytes(ROW);
		check(
			"nothing was written and nothing was retried: disk is exactly the agent's text",
			diskBytes.toString('utf8') === agentText,
		);
		check(
			'the conflict names the captured hash it expected',
			refused.expectedSha256 === captured.sha256,
		);
		check(
			'the conflict names the hash of what is on disk now',
			refused.actualSha256 === (await hashBytes(diskBytes)),
		);
		check(
			'the captured snapshot is unchanged and still holds the baseline',
			captured.source === baseline && Object.isFrozen(captured),
		);

		// The conflict carries hashes, not text: disk text takes one more read.
		const current = ok(await a.tables.todos.get('milk'));
		check(
			'one more get() gives the disk text, and its hash is the one the conflict named',
			current?.source === agentText && current.sha256 === refused.actualSha256,
		);
		// The candidate is the caller's own string; the refusal neither took nor changed it.
		check(
			'all three texts are in hand and distinct: baseline, candidate, and disk',
			candidate.includes('title: Buy milk and eggs') &&
				new Set([baseline, candidate, current?.source]).size === 3,
		);
		show('candidate (unsaved)', candidate);
		show('disk (agent)', agentText);

		// What the application does next is its own decision. Here: redo the
		// one-field change as a structured update, which reads current source.
		const merged = ok(
			await a.tables.todos.update('milk', {
				fields: { title: 'Buy milk and eggs' },
			}),
		);
		await a.close();
		check(
			"a structured update against current source keeps the agent's line and lands the title",
			merged.source ===
				agentText.replace('title: Buy milk', 'title: Buy milk and eggs') &&
				(await disk.text(ROW)) === merged.source,
		);
	}

	// -------------------------------------------------------------------------
	section('11. Newlines and Unicode: the receipt is the bytes on disk');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		// A byte-order mark, CRLF line endings, a decomposed é (e + U+0301)
		// beside a precomposed one, an emoji outside the BMP, and no final newline.
		const EXACT =
			'﻿---\r\ntitle: "Café vs Café \u{1F95B}"\r\ndone: false\r\n---\r\nLigne un\r\nLigne deux';
		const snapshot = ok(await a.tables.todos.get('milk'));
		if (snapshot === undefined) throw new Error('A did not find the row');
		const receipt = ok(await a.tables.todos.replace(snapshot, EXACT));
		const diskBytes = await disk.bytes(ROW);
		show(ROW, diskBytes.toString('utf8'));
		check(
			'the bytes on disk are the UTF-8 encoding of the submitted string',
			Buffer.compare(diskBytes, Buffer.from(encoder.encode(EXACT))) === 0,
		);
		check(
			'the receipt source is the submitted string, code unit for code unit',
			receipt.source === EXACT,
		);
		check(
			'the receipt hash is the hash of the bytes on disk',
			receipt.sha256 === (await hashBytes(diskBytes)),
		);
		check(
			'nothing normalized the decomposed é into the precomposed one',
			receipt.fields.title === 'Café vs Café \u{1F95B}' &&
				receipt.fields.title !== receipt.fields.title.normalize('NFC'),
		);
		check(
			'the body keeps CRLF and has no newline added at the end',
			receipt.body === 'Ligne un\r\nLigne deux',
		);

		// A structured update keeps the BOM and CRLF it finds.
		const updated = ok(
			await a.tables.todos.update('milk', { fields: { done: true } }),
		);
		check(
			'a structured update on that file keeps the BOM and every CRLF',
			updated.source === EXACT.replace('done: false', 'done: true') &&
				(await disk.text(ROW)) === updated.source,
		);

		// A string that is not valid UTF-16: the receipt reports the bytes, not the string.
		const LONE = '---\ntitle: lone \uD800 surrogate\ndone: false\n---\n';
		const lone = ok(await a.tables.todos.replace(updated, LONE));
		const loneDisk = await disk.text(ROW);
		await a.close();
		check(
			'for an unpaired surrogate the receipt differs from the submitted string',
			lone.source !== LONE,
		);
		check(
			'and it equals the text of the bytes on disk (U+FFFD)',
			lone.source === loneDisk && loneDisk.includes('�'),
		);
	}

	// -------------------------------------------------------------------------
	section('12. Files with unusual literal names that already exist');
	// -------------------------------------------------------------------------
	{
		// The agent creates these directly; no folder method chose the names.
		const names = ['.hidden', 'trailing ', ''];
		for (const stem of names)
			await disk.write(
				`todos/${stem}.md`,
				`---\ntitle: "stem=[${stem}]"\ndone: false\n---\n`,
			);
		// Not rows: the wrong case of extension, and a nested file.
		await disk.write('todos/shout.MD', '---\ntitle: not a row\n---\n');
		await mkdir(join(root, 'todos/nested'));
		await disk.write('todos/nested/deep.md', '---\ntitle: not a row\n---\n');
		note(
			`readdir(todos) = ${JSON.stringify((await readdir(join(root, 'todos'))).sort())}`,
		);

		const a = await open(appA);
		const listed = ok(await a.tables.todos.list());
		const stems = listed
			.map(({ result: { data: row, error } }) =>
				error === null ? row.stem : '<error>',
			)
			.sort();
		check(
			'list() discovers the leading-dot, trailing-space, and empty-stem rows beside milk',
			JSON.stringify(stems) ===
				JSON.stringify(['', '.hidden', 'milk', 'trailing '].sort()),
			stems,
		);
		check(
			'shout.MD and nested/deep.md are not rows',
			!listed.some(
				(item) => item.path.includes('shout') || item.path.includes('nested'),
			),
		);
		for (const stem of names) {
			const row = ok(await a.tables.todos.get(stem));
			const updated = ok(
				await a.tables.todos.update(stem, { fields: { done: true } }),
			);
			check(
				`stem ${JSON.stringify(stem)}: get() finds it at ${JSON.stringify(`todos/${stem}.md`)} and update() saves it there`,
				row?.stem === stem &&
					row.path === `todos/${stem}.md` &&
					row.fields.title === `stem=[${stem}]` &&
					updated.stem === stem &&
					(await disk.text(`todos/${stem}.md`)).includes('done: true\n'),
			);
		}
		const files = ok(await a.files.list());
		await a.close();
		const inventory = files.files.map((file) => file.path);
		check(
			'files.list() inventories every one of them, rows or not, at its literal path',
			[
				'todos/.hidden.md',
				'todos/trailing .md',
				'todos/.md',
				'todos/shout.MD',
				'todos/nested/deep.md',
				'kv.json',
			].every((path) => inventory.includes(path)),
			inventory,
		);
	}

	// -------------------------------------------------------------------------
	section('What is in the directory at the end');
	// -------------------------------------------------------------------------
	for (const entry of (await readdir(root, { recursive: true })).sort())
		if (!entry.startsWith('.git')) console.log(`  ${JSON.stringify(entry)}`);
	check(
		'opening the directory initialized a Git repository in it, though this run asked for none',
		disk.exists('.git'),
	);
	const commits = Bun.spawnSync([
		'git',
		'-C',
		root,
		'rev-list',
		'--all',
		'--count',
	]);
	check(
		'with commitOnEdit: false, no save made a commit',
		commits.stdout.toString().trim() === '0',
		commits.stdout.toString() + commits.stderr.toString(),
	);
} finally {
	// Only the directory this run made: under the system temp directory, with this run's prefix.
	const base = await realpath(tmpdir());
	if (root.startsWith(`${base}${sep}${PREFIX}`))
		await rm(root, { recursive: true, force: true });
	console.log(`\nRemoved ${root}: ${!existsSync(root)}`);
}

section('Result');
console.log(`  ${passed} assertions passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
if (failures.length > 0) process.exit(1);

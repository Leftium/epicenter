/**
 * Per-keystroke acceptance cost of a row editor, natively and through mounted
 * Svelte bindings in jsdom. Run with `bun run --filter @epicenter/folder bench`.
 *
 * Each sample is one synchronous keystroke: the setter formats or interprets
 * the whole row and, when mounted, Svelte flushes the DOM. Write replies are
 * held, so the first capture stays active and later ones coalesce as pending;
 * no storage, hashing after the first capture, or settlement is timed.
 * These numbers say nothing about publication rate, Git churn, reload
 * latency, or real I/O.
 */
import { arch, cpus, platform } from 'node:os';
import { openTodo, todo } from './row-storage.test-support.js';
import { type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: RowView } = await import('./fixtures/RowView.svelte');

const KEYSTROKES = 300;
const WARMUP = 30;

const shapes = {
	small: { extra: '', body: 'A short note about the plan.\n'.repeat(7) },
	'200-key header': {
		extra: Array.from(
			{ length: 200 },
			(_, i) => `"k${String(i).padStart(3, '0')}": "${'v'.repeat(40)}"\n`,
		).join(''),
		body: 'A short note.\n',
	},
	'200 KB body': { extra: '', body: `${'word '.repeat(40)}\n`.repeat(1000) },
};

type Mode = 'native setText' | 'raw textarea' | 'title input' | 'body textarea';

async function measure(shape: keyof typeof shapes, mode: Mode) {
	const { extra, body } = shapes[shape];
	// An empty title fails the schema, which keeps the raw view mounted.
	const initial = todo(mode === 'raw textarea' ? '' : 'Plan', body, extra);
	const fake = await openTodo(initial);
	fake.holdReplies();
	const target = document.createElement('div');
	document.body.append(target);
	const view =
		mode === 'native setText'
			? undefined
			: mount(RowView, { target, props: { rowEditor: fake.editor } });
	flushSync();
	const field = {
		'native setText': null,
		'raw textarea': 'textarea[aria-label="Markdown source"]',
		'title input': 'input[aria-label="Title"]',
		'body textarea': 'textarea[aria-label="Body"]',
	}[mode];
	const element = field === null ? null : target.querySelector(field);
	if (field !== null && element === null) throw new Error(`No ${field}`);
	let value = (
		{
			'native setText': initial,
			'raw textarea': initial,
			'title input': 'Plan',
			'body textarea': body,
		} satisfies Record<Mode, string>
	)[mode];
	const samples: number[] = [];
	for (let i = 0; i < WARMUP + KEYSTROKES; i += 1) {
		value += 'x';
		const start = performance.now();
		if (element === null) fake.editor.setText(value);
		else {
			type(element, value);
			flushSync();
		}
		if (i >= WARMUP) samples.push(performance.now() - start);
	}
	const { row } = fake.editor.get();
	if (!row.text.includes(value))
		throw new Error(`${shape} / ${mode}: the last keystroke was not accepted`);
	if (view !== undefined) void unmount(view);
	target.remove();
	fake.releaseReplies();
	samples.sort((a, b) => a - b);
	const at = (q: number) =>
		samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ??
		NaN;
	return {
		shape,
		mode,
		rowBytes: new TextEncoder().encode(row.text).length,
		medianMs: Number(at(0.5).toFixed(3)),
		p95Ms: Number(at(0.95).toFixed(3)),
		maxMs: Number(at(1).toFixed(3)),
	};
}

console.log(
	JSON.stringify({
		bun: Bun.version,
		platform: `${platform()} ${arch()}`,
		cpu: cpus()[0]?.model,
		keystrokes: KEYSTROKES,
	}),
);
const results = [];
for (const shape of Object.keys(shapes) as (keyof typeof shapes)[])
	for (const mode of [
		'native setText',
		'raw textarea',
		'title input',
		'body textarea',
	] as const)
		results.push(await measure(shape, mode));
console.table(results);

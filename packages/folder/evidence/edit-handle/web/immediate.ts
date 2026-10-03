/**
 * Immediate checkbox caller: one click, one conditional save, no handle.
 *
 * `edits.tables.todos.save(displayed, { fields: { done } })` patches the row
 * exactly as it was displayed and replaces it only if the file is still that
 * version. It never sees, saves, or discards the open form's draft. When
 * that form has unsaved changes on the same row, this save lands and the
 * form reports the file as changed elsewhere.
 *
 * This caller owns its pending saves, one per path. While one is pending,
 * the checkbox shows the wanted value and stays disabled through every
 * rerender, and another change for that path is not admitted, including one
 * dispatched by script. An unknown outcome is reported, never retried.
 */
import { h } from './dom.js';
import type { DemoFolder } from './folder-http.js';
import type { TodoEdits, TodoSnapshot } from './todo-edits.js';

type SaveResult = Awaited<ReturnType<TodoEdits['tables']['todos']['save']>>;

function describe(stem: string, saved: SaveResult): string {
	if (saved.error === null) return `${stem}: saved.`;
	switch (saved.error.name) {
		case 'Conflict':
			return `${stem}: not saved, the file changed since it was shown. Showing it as it is now.`;
		case 'Unconfirmed':
			return `${stem}: unknown, the reply was lost and the save may have landed. Not retried.`;
		case 'Unparsed':
		case 'UnsupportedSource':
		case 'InvalidValues':
			return `${stem}: not changed, its source does not take this change. Nothing was written.`;
		default:
			return `${stem}: not saved, ${saved.error.message}`;
	}
}

export function mountImmediateList(
	root: HTMLElement,
	{ folder, edits }: { folder: DemoFolder; edits: TodoEdits },
) {
	const status = h(
		'p',
		{ className: 'quiet' },
		'Click a checkbox to save it now.',
	);
	const list = h('ul', { className: 'immediate' });
	root.replaceChildren(list, status);
	/** The value each pending save wants, by path. */
	const pending = new Map<string, boolean>();
	let latest = 0;

	async function toggle(displayed: TodoSnapshot, done: boolean) {
		if (pending.has(displayed.path)) return;
		pending.set(displayed.path, done);
		void render();
		const saved = await edits.tables.todos.save(displayed, {
			fields: { done },
		});
		pending.delete(displayed.path);
		status.textContent = describe(displayed.stem, saved);
		await render();
	}

	async function render() {
		const request = ++latest;
		const listed = await folder.tables.todos.list();
		if (request !== latest) return;
		if (listed.error) {
			list.replaceChildren(h('li', {}, listed.error.message));
			return;
		}
		list.replaceChildren(
			...[...listed.data]
				.sort((a, b) => a.path.localeCompare(b.path))
				.map(({ path, result }) => {
					if (result.error)
						return h('li', {}, `${path}: ${result.error.message}`);
					const snapshot = result.data;
					const wanted = pending.get(path);
					const checkbox = h('input', {
						type: 'checkbox',
						checked: wanted ?? snapshot.fields.done === true,
						disabled:
							wanted !== undefined || typeof snapshot.fields.done !== 'boolean',
						onchange: () => {
							const held = pending.get(path);
							if (held !== undefined) {
								checkbox.checked = held;
								return;
							}
							checkbox.disabled = true;
							void toggle(snapshot, checkbox.checked);
						},
					});
					return h(
						'li',
						{},
						h(
							'label',
							{},
							checkbox,
							` ${snapshot.fields.title ?? snapshot.stem}`,
							wanted === undefined ? '' : ' (saving)',
						),
					);
				}),
		);
	}

	const stop = folder.onFilesChanged(() => void render());
	void render();
	return stop;
}

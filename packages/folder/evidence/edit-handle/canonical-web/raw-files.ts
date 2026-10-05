/**
 * Another caller in the same tab, in plain DOM: the selected row's file read
 * and written through `folder.files`, not through the editor. It is how one
 * tab changes, removes, or recreates the file under an open editor, which
 * hears these writes as change hints like any other writer's. It is not the
 * editor's repair: an editor repairs its own row through its source view.
 *
 * Every write here is a file command conditional on the bytes it just read,
 * so a change in between is a `Conflict` and writes nothing. Only "Write the
 * seed text" creates a missing file, and only because a person pressed it.
 */
import { parseDocument, stringify } from 'yaml';
import {
	type CapturedFile,
	type FileError,
	type Folder,
	frameRowText,
} from '../../../src/browser.js';
import { h } from './dom.js';
import { type definition, NEW_ROW, SEED } from './todos.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function mountRawFiles(
	root: HTMLElement,
	{
		folder,
		target,
		log,
	}: {
		folder: Folder<typeof definition>;
		target: () => string;
		log: (text: string) => void;
	},
) {
	const { files, onFilesChanged } = folder;
	// Every button below writes to this path; it is named so no write lands
	// on a row the person did not mean.
	const where = h('p', { className: 'warn' });
	const disk = h('pre', {});
	const text = h('textarea', { rows: 8, className: 'source' });
	const message = h('p', { className: 'message' });

	root.replaceChildren(
		where,
		h('h4', {}, 'On disk now'),
		disk,
		h('h4', {}, 'Write as another caller'),
		text,
		h(
			'div',
			{ className: 'row' },
			button('Load disk text', async () => {
				const { data: current } = await files.read(target());
				text.value = current === null ? '' : (decode(current) ?? '');
			}),
			button('Replace the file with this text', () =>
				replace('Replaced it with the text above', () => text.value),
			),
			button('Same values, reformatted', () =>
				replace('Rewrote it in another style', (source) =>
					restyle(source, (fields) => fields),
				),
			),
			button('Change the title', () =>
				replace('Changed its title', (source) =>
					restyle(source, (fields) => ({
						...fields,
						title: `${String(fields.title ?? '')} (edited elsewhere)`,
					})),
				),
			),
		),
		h(
			'div',
			{ className: 'row' },
			button('Remove the file', remove),
			button('Write the seed text (creates a missing file)', seed),
			button('Write bytes that are not UTF-8', () =>
				replace(
					'Wrote three bytes that are not UTF-8',
					() => Uint8Array.of(0x2d, 0xff, 0xfe),
				),
			),
		),
		message,
	);

	function button(label: string, onclick: () => void | Promise<void>) {
		return h(
			'button',
			{ type: 'button', onclick: () => void onclick() },
			label,
		);
	}

	function report(path: string, what: string, error: FileError | null) {
		message.textContent = error === null ? '' : `Not written: ${error.message}`;
		if (error === null) log(`Another caller, ${path}: ${what}`);
	}

	/**
	 * Read the file, then replace it on the condition that it still holds the
	 * bytes read. `next` gets their text, `undefined` when not UTF-8, and
	 * returns the content to write, or a reason to write nothing.
	 */
	async function replace(
		what: string,
		next: (source: string | undefined) => string | Uint8Array | Refusal,
	) {
		const path = target();
		const { data: current, error: readError } = await files.read(path);
		if (readError !== null) {
			message.textContent = `Not written: ${readError.message}`;
			return;
		}
		const content = next(decode(current));
		if (content instanceof Refusal) {
			message.textContent = `Not written: ${content.reason}`;
			return;
		}
		const { error } = await files.replace(current, content);
		report(path, what, error);
	}

	/** The seed text over the file as it was read, or a new file when there is none. */
	async function seed() {
		const path = target();
		const content = SEED[path] ?? NEW_ROW;
		const { data: current, error: readError } = await files.read(path);
		if (readError === null) {
			const { error } = await files.replace(current, content);
			report(path, 'Wrote its seed text', error);
		} else if (readError.name === 'NotFound') {
			const { error } = await files.create(path, content);
			report(path, 'Created it with its seed text', error);
		} else message.textContent = `Not written: ${readError.message}`;
	}

	async function remove() {
		const path = target();
		const { data: current, error: readError } = await files.read(path);
		if (readError !== null) {
			message.textContent = `Not removed: ${readError.message}`;
			return;
		}
		const { error } = await files.remove(current);
		message.textContent = error === null ? '' : `Not removed: ${error.message}`;
		if (error === null) log(`Another caller, ${path}: Removed it`);
	}

	let shown = 0;
	/** Repaint from the folder: after a hint for the target, and when it changes. */
	async function show() {
		const request = ++shown;
		where.textContent = `Target: ${target()}`;
		const { data: current, error } = await files.read(target());
		if (request !== shown) return;
		disk.textContent =
			error !== null
				? error.name === 'NotFound'
					? '(no file)'
					: `(${error.message})`
				: (decode(current) ??
					`(${current.bytes.length} bytes that are not UTF-8)`);
	}

	const stop = onFilesChanged((paths) => {
		if (paths.includes(target())) void show();
	});
	void show();
	return { show, stop };
}

function decode(file: CapturedFile): string | undefined {
	try {
		return utf8.decode(file.bytes);
	} catch {
		return undefined;
	}
}

/** Why a rewrite writes nothing. */
class Refusal {
	constructor(readonly reason: string) {}
}

/**
 * The file in another program's style: keys in reverse order, block YAML,
 * and a comment. An `edit` that changes nothing gives equal values in other
 * bytes. Source this program cannot read exactly is left alone.
 */
function restyle(
	source: string | undefined,
	edit: (fields: Record<string, unknown>) => Record<string, unknown>,
): string | Refusal {
	if (source === undefined) return new Refusal('the file is not UTF-8 text');
	const frame = frameRowText(source);
	if (frame.kind !== 'frontmatter')
		return new Refusal('the file has no frontmatter');
	const yaml = parseDocument(source.slice(frame.yamlStart, frame.yamlEnd));
	const problem = yaml.errors[0] ?? yaml.warnings[0];
	if (problem !== undefined) return new Refusal(problem.message);
	const values = (yaml.toJS() ?? {}) as Record<string, unknown>;
	const fields = Object.fromEntries(Object.entries(edit(values)).reverse());
	return `---\n# Rewritten by another caller\n${stringify(fields)}---\n${source.slice(frame.bodyStart)}`;
}

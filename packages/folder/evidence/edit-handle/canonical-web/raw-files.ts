/**
 * Raw file access, in plain DOM: the target file's bytes as text, and writes
 * through the same folder's `files` methods. These are real saves to the
 * persisted folder by a caller that is not the editor, so the editor hears
 * them as change hints like any other writer. Another tab is a separate
 * writer; this panel is the one-tab way to change the file under the editor.
 */
import { parseDocument, stringify } from 'yaml';
import { type Folder, frameSource } from '../../../src/browser.js';
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
	const disk = h('pre', {});
	const text = h('textarea', { rows: 8, className: 'source' });
	const message = h('p', { className: 'message' });

	root.replaceChildren(
		h('h4', {}, 'On disk now'),
		disk,
		h('h4', {}, 'Write as another caller'),
		text,
		h(
			'div',
			{ className: 'row' },
			button('Load disk text', async () => {
				text.value = (await diskText()) ?? '';
			}),
			button('Overwrite with this text', () =>
				write('Overwrote it with the text above', text.value),
			),
			button('Same values, reformatted', () => rewrite((fields) => fields)),
			button('Change the title', () =>
				rewrite((fields) => ({
					...fields,
					title: `${String(fields.title ?? '')} (edited elsewhere)`,
				})),
			),
		),
		h(
			'div',
			{ className: 'row' },
			button('Remove file', remove),
			button('Write seed text', () =>
				write('Wrote its seed text', SEED[target()] ?? NEW_ROW),
			),
			button('Write invalid UTF-8', () =>
				write(
					'Wrote three bytes that are not UTF-8',
					Uint8Array.of(0x2d, 0xff, 0xfe),
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

	/** The target's text, `undefined` when absent; a description when unreadable. */
	async function diskText(): Promise<string | undefined> {
		const { data, error } = await files.read(target());
		if (error !== null)
			return error.name === 'NotFound' ? undefined : `(${error.message})`;
		try {
			return utf8.decode(data.bytes);
		} catch {
			return `(${data.bytes.length} bytes that are not UTF-8)`;
		}
	}

	async function write(what: string, content: string | Uint8Array) {
		const path = target();
		const { error } = await files.overwrite(path, content);
		message.textContent = error === null ? '' : `Not written: ${error.message}`;
		if (error === null) log(`Raw write to ${path}: ${what}`);
	}

	async function remove() {
		const path = target();
		const { data: file, error: readError } = await files.read(path);
		if (readError !== null) {
			message.textContent = `Not removed: ${readError.message}`;
			return;
		}
		// The removal is conditional on the bytes just read.
		const { error } = await files.remove(file);
		message.textContent = error === null ? '' : `Not removed: ${error.message}`;
		if (error === null) log(`Raw removal of ${path}`);
	}

	/**
	 * Write the target's current values in another program's style: keys in
	 * reverse order, block YAML, and a comment. Equal values, other bytes.
	 * Source this program cannot read exactly is left alone.
	 */
	async function rewrite(
		edit: (fields: Record<string, unknown>) => Record<string, unknown>,
	) {
		const source = await diskText();
		const frame = frameSource(source ?? '');
		if (source === undefined || frame.kind !== 'frontmatter') {
			message.textContent = 'Not rewritten: the file has no frontmatter.';
			return;
		}
		const yaml = parseDocument(source.slice(frame.yamlStart, frame.yamlEnd));
		const problem = yaml.errors[0] ?? yaml.warnings[0];
		if (problem !== undefined) {
			message.textContent = `Not rewritten: ${problem.message}`;
			return;
		}
		const values = (yaml.toJS() ?? {}) as Record<string, unknown>;
		const fields = Object.fromEntries(Object.entries(edit(values)).reverse());
		await write(
			'Rewrote it in another style',
			`---\n# Rewritten by another caller\n${stringify(fields)}---\n${source.slice(frame.bodyStart)}`,
		);
	}

	let shown = 0;
	/** Repaint from the folder: after a hint for the target, and when it changes. */
	async function show() {
		const request = ++shown;
		const textNow = await diskText();
		if (request === shown) disk.textContent = textNow ?? '(no file)';
	}

	const stop = onFilesChanged((paths) => {
		if (paths.includes(target())) void show();
	});
	void show();
	return { show, stop };
}

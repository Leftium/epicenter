/**
 * Pinyin readings and phrase capture, as plain functions over text and DOM.
 *
 * Readings are derived on screen from the text that is already there. Nothing
 * here is saved, sent to a model, or written back into an expression, a note,
 * or a transcript: the base text always stays exactly what it was.
 */
import { pinyin } from 'pinyin-pro';

export type ReadingPart = { text: string; reading?: string };

const HAN = /\p{Script=Han}/u;
export const hasHan = (text: string) => HAN.test(text);

/**
 * Split text into Han characters with their readings and the runs between
 * them. The whole text is read at once, so a character is read as part of its
 * phrase (银行 is háng, 音乐 is yuè). The parts always join back to exactly the
 * text given: if they would not, the text is returned unannotated.
 */
export function readingParts(text: string): ReadingPart[] {
	if (text === '') return [];
	if (!hasHan(text)) return [{ text }];
	const parts: ReadingPart[] = [];
	let joined = '';
	for (const item of pinyin(text, { type: 'all' })) {
		joined += item.origin;
		if (item.isZh && item.pinyin) {
			parts.push({ text: item.origin, reading: item.pinyin });
			continue;
		}
		// Everything else stays as it is, merged into one run: spaces,
		// punctuation, Latin text, emoji, and Han without a known reading.
		const last = parts.at(-1);
		if (last && last.reading === undefined) last.text += item.origin;
		else parts.push({ text: item.origin });
	}
	return joined === text ? parts : [{ text }];
}

/** The Markdown elements that start a new line of text. */
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote';
const READINGS = 'rt,rp';
const SHOW_ELEMENT_AND_TEXT = 0x1 | 0x4;
const ELEMENT = 1;
const TEXT = 3;

/**
 * The text nodes under `root`, grouped into lines: a line ends at a `<br>`
 * and wherever the nearest block element changes. Text inside `skip` is left
 * out.
 */
function textLines(root: Element, skip: string): Text[][] {
	const lines: Text[][] = [];
	let line: Text[] = [];
	let block: Element | undefined;
	const end = () => {
		if (line.length > 0) lines.push(line);
		line = [];
	};
	const walker = root.ownerDocument.createTreeWalker(
		root,
		SHOW_ELEMENT_AND_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType === ELEMENT) {
			if ((node as Element).localName === 'br') end();
			continue;
		}
		const parent = node.parentElement;
		if (!parent || parent.closest(skip)) continue;
		const nearest = parent.closest(BLOCKS);
		const owner = nearest && root.contains(nearest) ? nearest : root;
		if (owner !== block) end();
		block = owner;
		line.push(node as Text);
	}
	end();
	return lines;
}

/**
 * Put readings into one settled Markdown subtree, in place. Elements stay
 * where they are: only text nodes are replaced, by the same text with each
 * read character wrapped in `<ruby>`. A line is read as a whole, so a phrase
 * that runs across emphasis or a link is still read as that phrase.
 *
 * This replaces text nodes Svelte made, so the owner must build a fresh
 * subtree whenever the content or the preference changes, and never update
 * one that was annotated.
 */
export function annotateMarkdown(root: HTMLElement) {
	const document = root.ownerDocument;
	const lines = textLines(
		root,
		'rt,rp,ruby,script,style,textarea,input,select,[contenteditable]',
	);
	for (const nodes of lines) {
		const text = nodes.map((node) => node.data).join('');
		if (!hasHan(text)) continue;
		let offset = 0;
		const parts = readingParts(text).map((part) => {
			const start = offset;
			offset += part.text.length;
			return { ...part, start, end: offset };
		});
		let position = 0;
		for (const node of nodes) {
			const start = position;
			const end = start + node.data.length;
			position = end;
			const fragment = document.createDocumentFragment();
			for (const part of parts) {
				if (part.end <= start || part.start >= end) continue;
				const visible = part.text.slice(
					Math.max(start - part.start, 0),
					Math.min(end - part.start, part.text.length),
				);
				// A read character is whole within one text node; the check keeps
				// the base text intact even if one ever were not.
				if (
					part.reading !== undefined &&
					part.start >= start &&
					part.end <= end
				) {
					const ruby = document.createElement('ruby');
					ruby.lang = 'zh';
					ruby.append(document.createTextNode(visible));
					const reading = document.createElement('rt');
					reading.textContent = part.reading;
					reading.setAttribute('aria-hidden', 'true');
					// Matches `ReadingText`: a pointer selection passes over readings.
					reading.className = 'select-none';
					ruby.append(reading);
					fragment.append(ruby);
				} else {
					fragment.append(document.createTextNode(visible));
				}
			}
			node.replaceWith(fragment);
		}
	}
}

/**
 * Marks the element holding one phrase source: a completed tutor message that
 * this device has saved. Its value is the message's ID. The conversation view
 * is the only writer of this attribute, so an unsaved or arriving message
 * never carries it.
 */
const SOURCE = '[data-phrase-source]';
/** Marks page furniture beside a message, such as its button. */
const BESIDE = '[data-capture-skip]';

/**
 * A message's text as it reads on screen without readings, one line per
 * block or `<br>`. A phrase typed by hand is checked against this.
 */
export function messageText(message: Element): string {
	return textLines(message, READINGS)
		.map((line) => line.map((node) => node.data).join(''))
		.join('\n');
}

/** Whether `phrase` is one exact run of text within one line of the message. */
export function messageHasPhrase(message: Element, phrase: string): boolean {
	return (
		phrase !== '' &&
		!/[\r\n]/.test(phrase) &&
		messageText(message).includes(phrase)
	);
}

/**
 * Whether `message` is a phrase source right now and still holds `phrase`.
 * Asked again when a phrase is accepted: the element a candidate was read
 * from may since have left the page or stopped being a source.
 */
export function sourceHoldsPhrase(message: Element, phrase: string): boolean {
	return (
		message.isConnected &&
		message.matches(SOURCE) &&
		messageHasPhrase(message, phrase)
	);
}

export type CapturedPhrase = {
	/** The selected base text, trimmed. Never includes a reading. */
	text: string;
	messageId: string;
	message: HTMLElement;
	/** Exactly the selected text within the message, for placing the popover. */
	range: Range;
};

/**
 * Read a selection as one phrase from one phrase source, or as nothing.
 *
 * The text is gathered from the selected text nodes themselves, not from
 * `Selection.toString()` or a clone, so readings never come along: a native
 * selection may start or end inside a reading, and that reading is simply
 * left out. A selection of readings alone therefore has no text and is
 * refused. So is a selection that takes in text from another message, from a
 * reply that is still arriving or a message that is not saved, or from more
 * than one line. Buttons beside a message are ignored, as is whitespace,
 * because a native selection often runs a little past its message.
 */
export function capturePhrase(
	selection: Selection | null,
): CapturedPhrase | undefined {
	if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	const document = common.ownerDocument;
	if (!document) return;

	// Assigned inside `take`, so they are declared with their full types.
	type Point = { node: Text; offset: number };
	let message = undefined as HTMLElement | undefined;
	let block = undefined as Element | undefined;
	let first = undefined as Point | undefined;
	let last = undefined as Point | undefined;
	let broken = false;
	let text = '';

	const take = (node: Text): boolean => {
		const from = node === range.startContainer ? range.startOffset : 0;
		const to = node === range.endContainer ? range.endOffset : node.data.length;
		const slice = node.data.slice(from, to);
		const parent = node.parentElement;
		if (slice === '' || !parent || parent.closest(READINGS)) return true;
		const owner = parent.closest<HTMLElement>(SOURCE);
		if (!owner) return slice.trim() === '' || parent.closest(BESIDE) !== null;
		if (parent.closest(BESIDE)) return true;
		if (message && owner !== message) return false;
		message = owner;
		const nearest = parent.closest(BLOCKS);
		const line = nearest && owner.contains(nearest) ? nearest : owner;
		if (first && (broken || line !== block)) text += '\n';
		broken = false;
		block = line;
		text += slice;
		first ??= { node, offset: from };
		last = { node, offset: to };
		return true;
	};

	if (common.nodeType === TEXT) {
		if (!take(common as Text)) return;
	} else {
		const walker = document.createTreeWalker(common, SHOW_ELEMENT_AND_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!range.intersectsNode(node)) continue;
			if (node.nodeType === ELEMENT) {
				if ((node as Element).localName === 'br' && first) broken = true;
			} else if (!take(node as Text)) return;
		}
	}

	const phrase = text.trim();
	if (!message || !first || !last || !message.isConnected) return;
	if (phrase === '' || /[\r\n]/.test(phrase)) return;
	const messageId = message.dataset.phraseSource;
	if (!messageId) return;
	const tight = document.createRange();
	tight.setStart(first.node, first.offset);
	tight.setEnd(last.node, last.offset);
	return { text: phrase, messageId, message, range: tight };
}

/** Elements that start a new line when page text is copied. */
const COPY_BLOCKS = `${BLOCKS},div,article,section,label,button,tr`;

/**
 * The selected text without readings, when the selection takes in a reading;
 * otherwise nothing, and the browser's own copy stands. A selection inside an
 * input or a textarea never reaches a reading, so copying from a field is
 * left alone.
 */
export function selectionBaseText(
	selection: Selection | null,
): string | undefined {
	if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
	const range = selection.getRangeAt(0);
	const common = range.commonAncestorContainer;
	const root =
		common.nodeType === ELEMENT ? (common as Element) : common.parentElement;
	if (!root) return;

	let hasReading = false;
	let block: Element | undefined;
	let broken = false;
	let text = '';
	const walker = root.ownerDocument.createTreeWalker(
		root,
		SHOW_ELEMENT_AND_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!range.intersectsNode(node)) continue;
		if (node.nodeType === ELEMENT) {
			const name = (node as Element).localName;
			if (name === 'rt' || name === 'rp') hasReading = true;
			else if (name === 'br' && text !== '') broken = true;
			continue;
		}
		const parent = node.parentElement;
		if (!parent) continue;
		if (parent.closest(READINGS)) {
			hasReading = true;
			continue;
		}
		const data = (node as Text).data;
		const slice = data.slice(
			node === range.startContainer ? range.startOffset : 0,
			node === range.endContainer ? range.endOffset : data.length,
		);
		const owner = parent.closest(COPY_BLOCKS) ?? root;
		// Indentation between two blocks is layout, not text.
		if (slice.trim() === '' && owner !== block) continue;
		if (text !== '' && (broken || owner !== block)) text += '\n';
		broken = false;
		block = owner;
		text += slice;
	}
	return hasReading && text !== '' ? text : undefined;
}

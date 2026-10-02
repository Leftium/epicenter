/**
 * Readings and phrase capture tests.
 * Readings keep the original text and read a character as part of its phrase,
 * across inline Markdown. Phrase capture takes base text only, from one line
 * of one saved tutor message. These run over a jsdom tree: they establish what
 * the functions do with a given tree and range, not how a browser makes a
 * selection with a mouse, a keyboard, or touch handles.
 *
 * Key behaviors:
 * - Parts join back to the exact text; polyphonic characters follow the phrase
 * - Annotation adds only `ruby` and `rt`, and never crosses a line
 * - A selection yields base text from one line of one phrase source, or nothing
 * - A typed phrase must be one exact run within one line of its message
 * - Copied text leaves readings out and leaves reading-free selections alone
 */
import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import {
	annotateMarkdown,
	capturePhrase,
	messageHasPhrase,
	messageText,
	readingParts,
	selectionBaseText,
	sourceHoldsPhrase,
} from './readings.js';

const join = (parts: { text: string }[]) =>
	parts.map((part) => part.text).join('');

/** Base text: what is left when every reading is taken out. */
function baseText(root: Node) {
	const copy = root.cloneNode(true) as Element | DocumentFragment;
	for (const node of copy.querySelectorAll('rt,rp')) node.remove();
	return copy.textContent;
}

function page(html: string) {
	const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
	return { window, document: window.document };
}

test('parts join back to the exact text and read polyphonic characters in their phrase', () => {
	const text = ' 😀 é <script>银行、重庆、音乐</script>\n顺便。';
	const parts = readingParts(text);
	expect(join(parts)).toBe(text);
	expect(parts.find((part) => part.text === '行')?.reading).toBe('háng');
	expect(parts.find((part) => part.text === '重')?.reading).toBe('chóng');
	expect(parts.find((part) => part.text === '乐')?.reading).toBe('yuè');
	expect(
		parts.some(
			(part) => part.reading === undefined && part.text.includes('😀'),
		),
	).toBe(true);
	// A character alone is read differently from the same character in a phrase.
	expect(readingParts('行')[0]?.reading).toBe('xíng');
});

test('parts leave English and unusual text exactly as it is', () => {
	expect(readingParts('')).toEqual([]);
	expect(readingParts('by the way, ok?')).toEqual([
		{ text: 'by the way, ok?' },
	]);
	for (const text of [
		'é and é stay distinct 顺便', // decomposed and composed spellings
		'\ud83d 行', // an unpaired surrogate
		'𠮷野家', // Han outside the basic plane
		'葛︀城', // a variation selector after a character
		'顺便　,，ＡＢＣ\t\r\n马马虎虎', // full-width forms and mixed whitespace
		'👨‍👩‍👧 家', // a joined emoji sequence
		'cut to the chase 意思是“开门见山”',
	]) {
		const parts = readingParts(text);
		expect(join(parts)).toBe(text);
		for (const part of parts) {
			if (part.reading !== undefined) {
				expect(part.text).toMatch(/^\p{Script=Han}$/u);
			}
		}
	}
});

test('Markdown annotation keeps elements and base text and reads across inline nodes', () => {
	const { document } = page('<div id="root"></div>');
	const root = document.querySelector<HTMLElement>('#root')!;
	root.innerHTML =
		'<p>我去银<strong>行</strong>，<a href="https://example.invalid">顺便</a>买咖啡。</p>' +
		'<ul><li>音<em>乐</em><ul><li>重庆</li></ul></li></ul>' +
		'<pre><code>音乐 &lt;script&gt;alert(1)&lt;/script&gt;</code></pre>' +
		'<p>no Chinese here</p>';
	const before = root.textContent;
	const strong = root.querySelector('strong');
	const link = root.querySelector('a');
	const elements = root.querySelectorAll('*').length;
	annotateMarkdown(root);
	expect(root.querySelector('strong rt')?.textContent).toBe('háng');
	expect(root.querySelector('em rt')?.textContent).toBe('yuè');
	expect(root.querySelector('li li rt')?.textContent).toBe('chóng');
	// The elements Markdown made are the same elements, not copies.
	expect(root.querySelector('strong')).toBe(strong);
	expect(root.querySelector('a')).toBe(link);
	expect(link?.getAttribute('href')).toBe('https://example.invalid');
	expect(root.querySelectorAll('a ruby')).toHaveLength(2);
	expect(root.querySelector('code ruby')).not.toBeNull();
	expect(baseText(root)).toBe(before);
	// Text that looks like markup stays text: nothing but ruby and rt was added.
	expect(root.querySelector('script')).toBeNull();
	const rubies = root.querySelectorAll('ruby').length;
	expect(root.querySelectorAll('rt')).toHaveLength(rubies);
	expect(root.querySelectorAll('*')).toHaveLength(elements + rubies * 2);
	expect(root.querySelector('p:last-child')?.innerHTML).toBe('no Chinese here');
	for (const reading of root.querySelectorAll('rt')) {
		expect(reading.getAttribute('aria-hidden')).toBe('true');
	}
	// Annotating an annotated tree adds nothing.
	const once = root.innerHTML;
	annotateMarkdown(root);
	expect(root.innerHTML).toBe(once);
});

test('a line break or a new block ends the phrase a character is read in', () => {
	const { document } = page(
		// 银行 across a break or across paragraphs is not the word 银行.
		'<div id="root"><p>银<br>行</p><p>音</p><p>乐</p><p>银行</p></div>',
	);
	const root = document.querySelector<HTMLElement>('#root')!;
	annotateMarkdown(root);
	expect(
		[...root.querySelectorAll('rt')].map((node) => node.textContent),
	).toEqual(['yín', 'xíng', 'yīn', 'lè', 'yín', 'háng']);
	expect(root.querySelectorAll('br')).toHaveLength(1);
});

/**
 * A conversation as Vocab renders it: two saved tutor messages, a learner
 * message, a tutor answer this device has not saved, and a partial reply.
 * Only the saved tutor messages are phrase sources.
 */
function exchange() {
	const { window, document } = page(
		'<div id="list">' +
			'<div class="bubble"><div data-phrase-source="one"><div class="prose"><p>我去银行，<strong>顺便</strong>买咖啡。</p>' +
			'<p>第二段 é 和 é。<br>第三行</p></div></div>' +
			'<button data-capture-skip data-save-phrase="one">Save a phrase</button></div>\n' +
			'<div class="bubble"><div id="learner">难怪</div></div>' +
			'<div class="bubble"><div data-phrase-source="two"><div class="prose"><p>  by the way  </p></div></div></div>' +
			'<div class="bubble"><div id="unsaved"><p>马马虎虎</p></div></div>' +
			'<div class="bubble"><div id="streaming">顺路</div></div>' +
			'</div>',
	);
	const one = document.querySelector<HTMLElement>(
		'[data-phrase-source="one"]',
	)!;
	const two = document.querySelector<HTMLElement>(
		'[data-phrase-source="two"]',
	)!;
	annotateMarkdown(one);
	annotateMarkdown(document.querySelector<HTMLElement>('#learner')!);
	annotateMarkdown(document.querySelector<HTMLElement>('#unsaved')!);
	/** The text node holding `text`, inside a reading when asked for one. */
	const node = (text: string, within: 'base' | 'reading' = 'base') => {
		const walker = document.createTreeWalker(document.body, 4);
		for (
			let current = walker.nextNode();
			current;
			current = walker.nextNode()
		) {
			const inReading = current.parentElement?.closest('rt') != null;
			if (
				current.textContent?.includes(text) &&
				inReading === (within === 'reading')
			)
				return current;
		}
		throw new Error(`no text node holds ${text}`);
	};
	const range = (start: [Node, number], end: [Node, number]) => {
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		const made = document.createRange();
		made.setStart(start[0], start[1]);
		made.setEnd(end[0], end[1]);
		selection.addRange(made);
		return selection;
	};
	const select = (start: [Node, number], end: [Node, number]) =>
		capturePhrase(range(start, end));
	return { window, document, one, two, node, range, select };
}

test('a selection is saved as base text only, from one saved tutor message', () => {
	const { window, document, one, two, node, select } = exchange();
	expect(capturePhrase(null)).toBeUndefined();
	window.getSelection()?.removeAllRanges();
	expect(capturePhrase(window.getSelection())).toBeUndefined();

	// Across characters that each carry a reading.
	const captured = select([node('顺'), 0], [node('便'), 1]);
	expect(captured?.text).toBe('顺便');
	expect(captured?.messageId).toBe('one');
	expect(captured?.message).toBe(one);
	expect(baseText(captured!.range.cloneContents())).toBe('顺便');

	// An arbitrary run: part of a text node, across the emphasis, to part of another.
	expect(select([node('银'), 0], [node('买'), 1])?.text).toBe('银行，顺便买');
	expect(select([node('，'), 0], [node('，'), 1])?.text).toBe('，');

	// Endpoints on elements rather than in text, as a triple click makes them.
	const paragraph = one.querySelector('p')!;
	expect(
		select([paragraph, 0], [paragraph, paragraph.childNodes.length])?.text,
	).toBe('我去银行，顺便买咖啡。');
	// Running on to the start of the next block takes nothing from it.
	expect(select([paragraph, 0], [one.querySelectorAll('p')[1]!, 0])?.text).toBe(
		'我去银行，顺便买咖啡。',
	);

	// Spelling is kept as it is: the decomposed and the composed é stay different.
	const spelled = select(
		[node('é'), 0],
		[node('é'), node('é').textContent!.length],
	);
	expect(spelled?.text).toBe('é 和 é。');
	expect(spelled?.text).not.toBe(spelled?.text.normalize('NFC'));

	// English from a message with no readings, trimmed like a pasted line.
	const english = two.querySelector('p')!;
	expect(select([english, 0], [english, 1])?.text).toBe('by the way');
	expect(select([node('by the way'), 5], [node('by the way'), 12])?.text).toBe(
		'the way',
	);
	expect(document.querySelectorAll('ruby').length).toBeGreaterThan(0);
});

test('a selection that starts or ends in a reading leaves the reading out', () => {
	const { node, select } = exchange();
	// From the middle of 顺's reading to the middle of 便's reading: 便 is the
	// only base text between the two points.
	expect(
		select([node('shùn', 'reading'), 2], [node('biàn', 'reading'), 2])?.text,
	).toBe('便');
	// From base text into the last character's reading.
	expect(select([node('顺'), 0], [node('biàn', 'reading'), 4])?.text).toBe(
		'顺便',
	);
	// Readings alone are not a phrase: within one reading, or all of one.
	expect(
		select([node('shùn', 'reading'), 0], [node('shùn', 'reading'), 4]),
	).toBeUndefined();
	expect(
		select([node('shùn', 'reading'), 1], [node('shùn', 'reading'), 3]),
	).toBeUndefined();
	const reading = node('biàn', 'reading').parentElement!;
	expect(select([reading, 0], [reading, 1])).toBeUndefined();
});

test('a selection across messages, lines, or text that is not a saved tutor message is refused', () => {
	const { document, one, two, node, select } = exchange();
	// Two saved tutor messages.
	expect(select([node('顺'), 0], [node('by the way'), 4])).toBeUndefined();
	expect(select([one, 0], [two, two.childNodes.length])).toBeUndefined();
	// A learner message, an unsaved answer, and a reply that is still arriving.
	const learner = document.querySelector('#learner')!;
	expect(
		select([learner, 0], [learner, learner.childNodes.length]),
	).toBeUndefined();
	const unsaved = document.querySelector('#unsaved p')!;
	expect(
		select([unsaved, 0], [unsaved, unsaved.childNodes.length]),
	).toBeUndefined();
	const streaming = document.querySelector('#streaming')!;
	expect(select([streaming, 0], [streaming, 1])).toBeUndefined();
	// A saved message together with any of them.
	expect(select([node('by the way'), 0], [unsaved, 2])).toBeUndefined();
	expect(
		select([node('by the way'), 0], [streaming.firstChild!, 1]),
	).toBeUndefined();
	expect(select([node('三'), 0], [node('难'), 1])).toBeUndefined();
	// Two paragraphs, or two lines of one paragraph.
	expect(select([node('咖'), 0], [node('段'), 1])).toBeUndefined();
	expect(select([node('和'), 0], [node('三'), 1])).toBeUndefined();
	// Whitespace alone.
	expect(
		select([node('by the way'), 0], [node('by the way'), 2]),
	).toBeUndefined();
});

test('the button and whitespace beside a message do not spoil a selection', () => {
	const { document, node, select } = exchange();
	const button = document.querySelector('[data-save-phrase="one"]')!;
	// From the last line over the button and the space between bubbles.
	const next = document.querySelectorAll('.bubble')[1]!;
	expect(select([node('三'), 0], [next, 0])?.text).toBe('三行');
	expect(select([node('三'), 0], [button.firstChild!, 4])?.text).toBe('三行');
	// The button alone is not a phrase.
	expect(
		select([button.firstChild!, 0], [button.firstChild!, 4]),
	).toBeUndefined();
});

test('a typed phrase must be one exact run within one line of the message', () => {
	const { one, two } = exchange();
	expect(messageText(one)).toBe(
		'我去银行，顺便买咖啡。\n第二段 é 和 é。\n第三行',
	);
	expect(messageText(two)).toBe('  by the way  ');
	expect(messageHasPhrase(one, '顺便')).toBe(true);
	expect(messageHasPhrase(one, '银行，顺便买')).toBe(true);
	expect(messageHasPhrase(one, 'é 和')).toBe(true);
	expect(messageHasPhrase(two, 'by the way')).toBe(true);
	// A reading, text of another message, a different spelling, and a run across lines.
	expect(messageHasPhrase(one, 'shùn')).toBe(false);
	expect(messageHasPhrase(one, 'by the way')).toBe(false);
	expect(messageHasPhrase(one, 'é 和')).toBe(false);
	expect(messageHasPhrase(two, 'By the way')).toBe(false);
	expect(messageHasPhrase(one, '咖啡。第二段')).toBe(false);
	expect(messageHasPhrase(one, '咖啡。\n第二段')).toBe(false);
	expect(messageHasPhrase(one, '')).toBe(false);
});

test('a phrase is accepted only while its message is still a connected phrase source', () => {
	const { one } = exchange();
	expect(sourceHoldsPhrase(one, '顺便')).toBe(true);
	expect(sourceHoldsPhrase(one, '难怪')).toBe(false);
	// The message stops being a source: storage fell behind after it was read.
	one.removeAttribute('data-phrase-source');
	expect(sourceHoldsPhrase(one, '顺便')).toBe(false);
	one.setAttribute('data-phrase-source', 'one');
	// The message leaves the page: its chat was switched or its tree rebuilt.
	one.remove();
	expect(sourceHoldsPhrase(one, '顺便')).toBe(false);
});

test('copied text leaves readings out and keeps lines, and a selection without readings is left to the browser', () => {
	const { document, one, node, range } = exchange();
	expect(selectionBaseText(null)).toBeUndefined();
	// Within one line, across readings.
	expect(selectionBaseText(range([node('银'), 0], [node('买'), 1]))).toBe(
		'银行，顺便买',
	);
	// A whole message: one line per block and per break, no readings.
	expect(selectionBaseText(range([one, 0], [one, one.childNodes.length]))).toBe(
		'我去银行，顺便买咖啡。\n第二段 é 和 é。\n第三行',
	);
	// Across bubbles, each on its own line.
	expect(selectionBaseText(range([node('三'), 0], [node('怪'), 1]))).toBe(
		'三行\nSave a phrase\n难怪',
	);
	// Readings alone carry no base text, and English has no readings to remove.
	expect(
		selectionBaseText(
			range([node('shùn', 'reading'), 0], [node('shùn', 'reading'), 4]),
		),
	).toBeUndefined();
	expect(
		selectionBaseText(range([node('by the way'), 2], [node('by the way'), 8])),
	).toBeUndefined();
	const streaming = document.querySelector('#streaming')!;
	expect(
		selectionBaseText(range([streaming, 0], [streaming, 1])),
	).toBeUndefined();
});

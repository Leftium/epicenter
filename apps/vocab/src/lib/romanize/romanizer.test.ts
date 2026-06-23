import { describe, expect, test } from 'bun:test';
import { pinyinRomanizer } from './pinyin.js';
import { annotate } from './romanizer.js';

describe('pinyinRomanizer', () => {
	test('segments cover the whole input in order, lossless', () => {
		const input = 'Hello 你好, world 世界!';
		const segments = pinyinRomanizer(input);
		expect(segments.map((s) => s.text).join('')).toBe(input);
	});

	test('Chinese characters get a reading; everything else does not', () => {
		const segments = pinyinRomanizer('你 a');
		const ni = segments.find((s) => s.text === '你');
		const latin = segments.find((s) => s.text.includes('a'));
		expect(ni?.reading).toBeTruthy();
		expect(latin?.reading).toBeUndefined();
	});

	test('one segment per Chinese character (per-character ruby)', () => {
		const chinese = pinyinRomanizer('你好').filter((s) => s.reading);
		expect(chinese.map((s) => s.text)).toEqual(['你', '好']);
	});
});

describe('annotate', () => {
	test('wraps reading segments in ruby and leaves tags untouched', () => {
		const html = annotate('<p>你 ok</p>', pinyinRomanizer);
		expect(html).toContain('<p>');
		expect(html).toContain('</p>');
		expect(html).toContain('<ruby>你');
		expect(html).toContain('<rt>');
		// Latin text is not wrapped.
		expect(html).toContain(' ok');
		expect(html).not.toContain('<ruby>ok');
	});

	test('does not romanize inside tag names or attributes', () => {
		// A tag carrying CJK-looking attribute content stays a tag, not ruby.
		const html = annotate('<a href="/x">链接</a>', pinyinRomanizer);
		expect(html).toContain('<a href="/x">');
		expect(html).toContain('<ruby>链');
	});
});

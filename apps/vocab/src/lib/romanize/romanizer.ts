/**
 * Romanization as a one-shot, language-agnostic strategy.
 *
 * A {@link Romanizer} splits text into segments and attaches a `reading` to the
 * ones that have one (pinyin for Chinese, romaji for Japanese, and so on). It
 * runs once per settled message, off the streaming path, so it can be as heavy
 * as a language needs. An app injects its romanizer; the renderer stays generic.
 */

/** One run of text, with a `reading` when it romanizes (absent = render as-is). */
export type Segment = { text: string; reading?: string };

/** Split text into segments, attaching a reading to the ones that have one. */
export type Romanizer = (text: string) => Segment[];

/**
 * Annotate the text nodes of an HTML string with ruby readings from
 * `romanizer`, leaving tags untouched. The romanizer must return segments whose
 * concatenated `text` equals its input, so non-reading runs (and HTML entities)
 * pass through verbatim. Runs once on a settled message, never per streamed
 * token, so re-walking the whole HTML is fine.
 */
export function annotate(html: string, romanizer: Romanizer): string {
	// Splitting on tags yields tags at odd indices and text nodes at even ones.
	const parts = html.split(/(<[^>]*>)/);
	for (let i = 0; i < parts.length; i += 2) {
		const text = parts[i];
		if (!text) continue;
		parts[i] = romanizer(text).map(toRuby).join('');
	}
	return parts.join('');
}

/** A segment with a reading becomes a ruby; one without passes through. */
function toRuby({ text, reading }: Segment): string {
	if (!reading) return text;
	return `<ruby>${text}<rp>(</rp><rt>${reading}</rt><rp>)</rp></ruby>`;
}

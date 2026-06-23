<!--
	Renders an assistant message's prose. Vocab is capability-free, so a message
	is one run of text (not the tool-call/tool-result parts the tool-agent apps
	render); this turns that text into sanitized markdown with optional pinyin.
-->
<script lang="ts">
	import DOMPurify from 'dompurify';
	import { marked } from 'marked';
	import { pinyinRomanizer } from '$lib/romanize/pinyin';
	import { annotate } from '$lib/romanize/romanizer';

	type Props = {
		content: string;
		showPinyin: boolean;
	};

	let { content, showPinyin }: Props = $props();

	const PURIFY_CONFIG = {
		ADD_TAGS: ['ruby', 'rt', 'rp'],
	};

	const html = $derived.by(() => {
		const raw = marked.parse(content, { breaks: true, gfm: true }) as string;
		const annotated = showPinyin ? annotate(raw, pinyinRomanizer) : raw;
		return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
	});
</script>

<div class="prose prose-sm">{@html html}</div>

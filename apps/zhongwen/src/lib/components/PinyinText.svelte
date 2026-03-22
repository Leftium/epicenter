<script lang="ts">
	import { segmentText } from '$lib/pinyin/annotate';

	type Props = {
		text: string;
		showPinyin?: boolean;
	};

	let { text, showPinyin = true }: Props = $props();

	const segments = $derived(segmentText(text));
</script>

{#each segments as segment}
	{#if segment.type === 'text'}
		{segment.content}
	{:else if showPinyin}
		{#each [...segment.characters] as char, i}
			<ruby class="pinyin-char">{char}<rp>(</rp><rt>{segment.pinyin[i] ?? ''}</rt><rp>)</rp></ruby>
		{/each}
	{:else}
		{segment.characters}
	{/if}
{/each}

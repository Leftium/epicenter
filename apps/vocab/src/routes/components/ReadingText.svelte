<script lang="ts">
	import { useReading } from '$lib/reading-preference.js';
	import { readingParts } from '$lib/readings.js';

	// Plain text with readings above it while the preference is on. The text is
	// rendered as text and is never changed; the readings exist only here.
	// The template is whitespace-tight: a line break between parts would put a
	// space into the text.
	let { text }: { text: string } = $props();

	const reading = useReading();
	const parts = $derived(reading.showPinyin ? readingParts(text) : [{ text }]);
</script>

{#each parts as part, index (index)}{#if part.reading !== undefined}<ruby lang="zh">{part.text}<rt aria-hidden="true" class="select-none">{part.reading}</rt></ruby>{:else}{part.text}{/if}{/each}

<script lang="ts">
	import { Markdown } from '@epicenter/ui/markdown';
	import { useReading } from '$lib/reading-preference.js';
	import { annotateMarkdown } from '$lib/readings.js';

	// A settled message as Markdown, with readings while the preference is on.
	// The shared component renders the message as elements and text, never as
	// an HTML string; readings are added to that tree afterward.
	let { content }: { content: string } = $props();

	const reading = useReading();
</script>

<!-- Annotating replaces text nodes that Svelte made, so an annotated tree is
     never updated: the key builds a fresh one whenever the message or the
     preference changes. -->
{#key `${reading.showPinyin}:${content}`}
	{#if reading.showPinyin}
		<div {@attach annotateMarkdown}><Markdown {content} /></div>
	{:else}
		<Markdown {content} />
	{/if}
{/key}

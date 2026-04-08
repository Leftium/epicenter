<script lang="ts">
	import { format } from 'date-fns';
	import type { Entry } from '$lib/workspace';

	let {
		entry,
		wordCount,
	}: {
		entry: Entry | null;
		wordCount: number;
	} = $props();

	function parseDateTime(dts: string): Date {
		return new Date(dts.split('|')[0]!);
	}
</script>

<div class="flex items-center justify-between border-t px-4 py-1.5 text-xs text-muted-foreground">
	<div class="flex items-center gap-3">
		{#if entry}
			<span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
			{#if entry.tags.length > 0}
				<span>{entry.tags.join(', ')}</span>
			{/if}
		{/if}
	</div>
	<div class="flex items-center gap-3">
		{#if entry}
			<span>Created {format(parseDateTime(entry.createdAt), 'MMM d, yyyy')}</span>
			<span>Updated {format(parseDateTime(entry.updatedAt), 'MMM d · h:mm a')}</span>
		{/if}
	</div>
</div>

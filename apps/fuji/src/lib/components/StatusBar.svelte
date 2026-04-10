<script lang="ts">
	import { format } from 'date-fns';
	import { DateTimeString } from '@epicenter/workspace';
	import type { Entry } from '$lib/workspace/definition';

	let {
		entry,
		wordCount,
	}: {
		entry: Entry;
		wordCount: number;
	} = $props();
</script>

<div class="flex items-center justify-between border-t px-4 py-1.5 text-xs text-muted-foreground">
	<span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
	<div class="flex items-center gap-3">
		<span>Created {format(DateTimeString.toDate(entry.createdAt), 'MMM d, yyyy · h:mm a')}</span>
		<span>Updated {format(DateTimeString.toDate(entry.updatedAt), 'MMM d, yyyy · h:mm a')}</span>
	</div>
</div>

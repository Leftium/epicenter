<script lang="ts">
	import { Kbd } from '@epicenter/ui/kbd';

	let { entryCount }: {
		entryCount: number;
	} = $props();
</script>

<div class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground">
	<span>{entryCount} {entryCount === 1 ? 'entry' : 'entries'}</span>
	<div class="ml-auto flex items-center gap-1.5">
		<span class="flex items-center gap-1">
			Search <Kbd>⌘K</Kbd>
		</span>
	</div>
</div>

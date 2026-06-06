<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';

	// The shared empty-cell indicator, rendered by every Field's empty branch. With
	// everything-required, an empty modeled cell is always NEEDS_VALUE (an absent key
	// or explicit null on a required field), so this is unconditionally the "required"
	// badge. No state prop: the dispatch gates INVALID elsewhere and OK shows a value,
	// so the only state a Field's empty branch ever has is NEEDS_VALUE.
</script>

<Badge
	variant="outline"
	aria-invalid="true"
	class="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
>
	required
</Badge>

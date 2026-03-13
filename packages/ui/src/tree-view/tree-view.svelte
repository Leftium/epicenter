<script lang="ts">
	import { cn } from '../utils.js';
	import type { TreeViewRootProps } from './types';

	let { children, class: className, ...rest }: TreeViewRootProps = $props();
</script>

<div class={cn('flex flex-col', className)} {...rest}>
	{@render children?.()}
</div>

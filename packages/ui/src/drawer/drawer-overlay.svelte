<script lang="ts">
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DrawerPrimitive.OverlayProps = $props();
</script>

<DrawerPrimitive.Overlay
	bind:ref
	data-slot="drawer-overlay"
	class={cn(
		'cn-drawer-overlay fixed inset-0 z-50',
		// Override to z-40 to ensure that alert-dialogs (which are at z-50) are always on top of drawers
		'z-40',
		className,
	)}
	{...restProps}
/>

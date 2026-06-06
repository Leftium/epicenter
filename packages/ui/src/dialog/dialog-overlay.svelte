<script lang="ts">
	import { Dialog as DialogPrimitive } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn(
		'cn-dialog-overlay fixed inset-0 isolate z-50',
		// Override to z-40 to ensure that alert-dialogs (which are at z-50) are always on top of dialogs
		'z-40',
		className,
	)}
	{...restProps}
/>

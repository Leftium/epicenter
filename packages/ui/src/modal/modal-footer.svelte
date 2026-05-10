<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { WithElementRef } from 'bits-ui';
	import type { HTMLAttributes } from 'svelte/elements';

	import * as Dialog from '#ui/dialog';
	import * as Drawer from '#ui/drawer';

	import { useModalSub } from './modal-state.svelte.js';

	const modal = useModalSub();

	let {
		children,
		ref = $bindable(null),
		...rest
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Footer bind:ref {...rest}> {@render children?.()} </Dialog.Footer>
{:else}
	<Drawer.Footer bind:ref {...rest}> {@render children?.()} </Drawer.Footer>
{/if}

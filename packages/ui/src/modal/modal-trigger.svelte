<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import type { DialogTriggerProps } from 'bits-ui';

	import * as Dialog from '#ui/dialog';
	import * as Drawer from '#ui/drawer';

	import { useModalSub } from './modal-state.svelte.js';

	const modal = useModalSub();

	let {
		children,
		ref = $bindable(null),
		...rest
	}: DialogTriggerProps = $props();
</script>

{#if modal.view === 'desktop'}
	<Dialog.Trigger bind:ref {...rest}> {@render children?.()} </Dialog.Trigger>
{:else}
	<Drawer.Trigger bind:ref {...rest}> {@render children?.()} </Drawer.Trigger>
{/if}

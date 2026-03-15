<script lang="ts">
	import { CommandPalette } from '@epicenter/ui/command-palette';
	import { quickActions } from '$lib/quick-actions';

	let { open = $bindable(false) }: { open: boolean } = $props();
</script>

<CommandPalette items={quickActions} bind:open />

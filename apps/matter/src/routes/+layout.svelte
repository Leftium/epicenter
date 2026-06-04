<script lang="ts">
	import '@epicenter/ui/app.css';
	import { ModeWatcher } from 'mode-watcher';

	let { children } = $props();
</script>

<svelte:head><title>Matter</title></svelte:head>

{@render children?.()}

<ModeWatcher defaultMode="dark" track={false} />

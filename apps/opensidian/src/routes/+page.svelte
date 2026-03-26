<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';

	onMount(() => {
		void authState.refreshSession();
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.status === 'signed-in'
			) {
				void authState.refreshSession();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () =>
			document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

{#await authState.whenReady}
	<div class="flex h-screen items-center justify-center">
		<p class="text-sm text-muted-foreground">Loading workspace…</p>
	</div>
{:then _}
	<AppShell />
{/await}

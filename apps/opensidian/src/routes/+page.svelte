<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';

	onMount(() => {
		authState.checkSession();
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.status === 'signed-in'
			) {
				authState.checkSession();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () =>
			document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

<AppShell />

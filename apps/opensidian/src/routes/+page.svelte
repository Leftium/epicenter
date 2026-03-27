<script lang="ts">
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';
	import { workspaceAuth } from '$lib/workspace.svelte';

	onMount(() => {
		void workspaceAuth.startAppBoot();
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.session.status === 'authenticated'
			) {
				void workspaceAuth.refresh();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () =>
			document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

<AppShell />

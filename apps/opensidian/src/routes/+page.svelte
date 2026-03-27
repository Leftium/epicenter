<script lang="ts">
	import { installWorkspaceFirstBoot } from '@epicenter/svelte/auth';
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';
	import { ws } from '$lib/workspace.svelte';

	onMount(() => {
		const cleanupWorkspaceBoot = installWorkspaceFirstBoot({
			workspace: ws,
			auth: authState,
		});
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.session.status === 'authenticated'
			) {
				void authState.refresh();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => {
			cleanupWorkspaceBoot();
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});
</script>

<AppShell />

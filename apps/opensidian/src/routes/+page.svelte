<script lang="ts">
	import { createWorkspaceFirstBoot } from '@epicenter/svelte/auth';
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';
	import { ws } from '$lib/workspace.svelte';

	const workspaceBoot = createWorkspaceFirstBoot({
		workspace: ws,
		auth: authState,
	});

	onMount(() => {
		void workspaceBoot.start();
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.session.status === 'authenticated'
			) {
				void authState.refresh();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () =>
			document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

<AppShell />

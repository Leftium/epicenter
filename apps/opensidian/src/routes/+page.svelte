<script lang="ts">
	import {
		refreshAppAuth,
		startAppBoot,
	} from '@epicenter/svelte/auth';
	import { onMount } from 'svelte';
	import { authState } from '$lib/auth';
	import AppShell from '$lib/components/AppShell.svelte';
	import { ws } from '$lib/workspace.svelte';

	onMount(() => {
		void startAppBoot({
			workspace: ws,
			auth: authState,
			reconnect: () => ws.extensions.sync.reconnect(),
		});
		const onVisibilityChange = () => {
			if (
				document.visibilityState === 'visible' &&
				authState.session.status === 'authenticated'
			) {
				void refreshAppAuth({
					workspace: ws,
					auth: authState,
					reconnect: () => ws.extensions.sync.reconnect(),
				});
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () =>
			document.removeEventListener('visibilitychange', onVisibilityChange);
	});
</script>

<AppShell />

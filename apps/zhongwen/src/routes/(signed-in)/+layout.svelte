<script lang="ts">
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { Loading } from '@epicenter/ui/loading';
	import { goto } from '$app/navigation';
	import { auth } from '$platform/auth';
	import { session } from '$lib/session.svelte';

	let { children } = $props();

	const current = $derived(session.current);

	$effect(() => {
		if (!current) {
			void goto('/sign-in', { replaceState: true });
		}
	});
</script>

{#if current}
	<WorkspaceGate
		pending={current.workspace.zhongwen.idb.whenLoaded}
		onSignOut={() => auth.signOut()}
	>
		{@render children?.()}
	</WorkspaceGate>
{:else}
	<Loading class="h-dvh" />
{/if}

<script lang="ts">
	import { SignedOutScreen } from '@epicenter/app-shell/instance-settings';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '$lib/instance';
	import { requireFuji, session } from '$lib/session';
	import FujiAppShell from './components/FujiAppShell.svelte';

	let { children } = $props();
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireFuji().wipe()}
		onSignOut={() => auth.signOut()}
	>
		<FujiAppShell>{@render children?.()}</FujiAppShell>
	</WorkspaceGate>
{:else}
	<SignedOutScreen
		appName="Fuji"
		tagline="Sync your entries across devices."
		{auth}
		setting={instanceSetting}
	/>
{/if}

<script lang="ts">
	import { SignedOutScreen } from '@epicenter/app-shell/instance-settings';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import { instanceSetting } from '$lib/instance';
	import { requireOpensidian, session } from '$lib/session';
	import { auth } from '$platform/auth';

	let { children } = $props();
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireOpensidian().wipe()}
		onSignOut={() => auth.signOut()}
	>
		{@render children()}
	</WorkspaceGate>
{:else}
	<SignedOutScreen
		appName="Opensidian"
		tagline="Sync your notes across devices."
		{auth}
		setting={instanceSetting}
	/>
{/if}

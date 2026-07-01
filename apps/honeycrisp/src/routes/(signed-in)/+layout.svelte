<script lang="ts">
	import { SignedOutScreen } from '@epicenter/app-shell/instance-settings';
	import { WorkspaceGate } from '@epicenter/app-shell/workspace-gate';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { auth } from '#platform/auth';
	import { instanceSetting } from '$lib/instance';
	import { requireHoneycrisp, session } from '$lib/session';

	let { children } = $props();
</script>

{#if session.current}
	<WorkspaceGate
		pending={session.current.idb.whenLoaded}
		onForgetDevice={() => requireHoneycrisp().wipe()}
		onSignOut={() => auth.signOut()}
	>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</WorkspaceGate>
{:else}
	<SignedOutScreen
		appName="Honeycrisp"
		tagline="Sync your notes across devices."
		{auth}
		setting={instanceSetting}
	/>
{/if}

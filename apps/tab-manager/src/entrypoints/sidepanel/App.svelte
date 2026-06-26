<script lang="ts">
	import { SignedOutScreen } from '@epicenter/app-shell/instance-settings';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { tabManagerSession } from '$lib/session.svelte';
	import SignedInApp from './SignedInApp.svelte';
</script>

{#await tabManagerSession.whenReady}
	<Loading class="h-full" label="Loading tabs…" />
{:then}
	{#if tabManagerSession.current}
		{#await tabManagerSession.current.idb.whenLoaded}
			<Loading class="h-full" label="Loading tabs…" />
		{:then}
			<SignedInApp />
		{:catch}
			<Empty.Root class="h-full border-0">
				<Empty.Media>
					<TriangleAlertIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>Failed to load workspace</Empty.Title>
				<Empty.Description> Try reopening the side panel. </Empty.Description>
			</Empty.Root>
		{/await}
	{:else}
		<SignedOutScreen
			appName="Epicenter"
			tagline="Sync your tabs across devices."
			auth={tabManagerSession.auth}
			setting={tabManagerSession.instanceSetting}
			class="h-full bg-background"
		/>
	{/if}
{:catch}
	<Empty.Root class="h-full border-0">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load account</Empty.Title>
		<Empty.Description> Try reopening the side panel. </Empty.Description>
	</Empty.Root>
{/await}

<ModeWatcher />
<Toaster position="bottom-center" richColors closeButton />

<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { onDestroy } from 'svelte';
	import { openSession } from '$lib/session.svelte.js';
	import AppShell from './components/AppShell.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// The mounted layout acquires the folder, once, and every page below shares
	// it: a route change renders another page inside the same session. Importing
	// modules opens nothing, and no page opens a folder of its own.
	const opening = openSession();

	onDestroy(() => {
		void opening.then((session) => session.close()).catch(() => {});
	});
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{#await opening}
		<Loading class="h-dvh" label="Opening your recordings…" />
	{:then session}
		<AppShell {session}>{@render props.children?.()}</AppShell>
	{:catch error}
		<Empty.Root class="h-dvh">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open the recordings folder</Empty.Title>
			<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Root>
	{/await}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />

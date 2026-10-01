<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { createLibrary } from '$lib/library.svelte.js';
	import { openWorkspace } from '$lib/workspace/index.js';
	import WhisperingView from './components/WhisperingView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	const opening = openWorkspace().then(async (workspace) => {
		const library = createLibrary(workspace);
		await library.start();
		return library;
	});

	onDestroy(() => {
		void opening.then((library) => library.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then library}
	<WhisperingView {library} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the recordings folder</Empty.Title>
		<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
	</Empty.Root>
{/await}

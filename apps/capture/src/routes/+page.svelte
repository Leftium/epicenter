<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { openCaptureHost } from '#platform/folder';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path.
	const opening = openCaptureHost().then(async (host) => {
		const captures = createCaptures(host);
		// Listen before the first read, so no change falls between them. The
		// folder drops the listener when it closes.
		host.onExternalChange(() => void captures.refresh());
		await captures.refresh();
		return { host, captures };
	});

	onDestroy(() => {
		void opening
			.then(async ({ host, captures }) => {
				await captures.close();
				return host.close();
			})
			.catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your captures…" />
{:then { host, captures }}
	<CaptureApp {host} {captures} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open the captures folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}

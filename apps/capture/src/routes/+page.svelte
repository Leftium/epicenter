<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { openCaptureHost, openDeparture } from '#platform/folder';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path.
	//
	// On the desktop, the host's departure question is heard before the folder
	// opens, so no round is missed; a round that arrives while it opens waits
	// for it. A browser tab has none.
	const departure = openDeparture();
	const opening = openCaptureHost().then(async (host) => {
		const captures = createCaptures(host);
		departure?.attach(captures.departure);
		// Listen before the first read, so no change falls between them. The
		// folder drops the listener when it closes.
		host.onExternalChange(() => void captures.refresh());
		await captures.refresh();
		return { host, captures };
	});
	// A page whose folder did not open has nothing to settle.
	opening.catch(() => departure?.attach(null));

	onDestroy(() => {
		departure?.close();
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
{:then { captures }}
	{#if departure?.startProblem !== undefined}
		<Empty.Root class="h-dvh">
			<Empty.Header>
				<Empty.Title>Capture cannot hear Epicenter</Empty.Title>
				<Empty.Description role="alert">Quitting Epicenter could not ask this window about unsaved text, so editing stays closed: {departure.startProblem}</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button variant="outline" size="sm" disabled={departure.starting} onclick={() => departure.retry()}>Try again</Button></Empty.Content>
		</Empty.Root>
	{:else if departure && !departure.everIdle}
		<!-- Nothing is typed until Epicenter says it is staying open. -->
		<Loading class="h-dvh" label={departure.fenced ? 'Epicenter is closing…' : 'Opening your captures…'} />
	{:else}
		<CaptureApp {captures} {departure} />
	{/if}
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open the captures folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" disabled={departure?.fenced} onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}

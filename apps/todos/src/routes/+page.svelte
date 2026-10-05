<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { departurePort } from '#platform/departure';
	import { openTodosFolder } from '#platform/folder';
	import { createDeparture } from '$lib/departure.svelte.js';
	import { openTodosPage } from '$lib/open-todos-page.js';
	import TodosView from './components/TodosView.svelte';

	const log = createLogger('todos/page');

	// Inside Epicenter, quitting or restarting asks this page first; a browser
	// build has no port and keeps its own leave warning.
	const departure =
		departurePort === undefined ? undefined : createDeparture(departurePort);

	/**
	 * Why this page has not opened its todos yet: it could not listen for
	 * Epicenter's quit and restart, or could not read whether one is running.
	 * Nothing is opened or editable meanwhile; Retry asks again.
	 */
	let unready = $state<string | undefined>();
	/** A status from the host has been applied; the page no longer waits on it. */
	let known = false;

	/** Listen, and read whether a quit or restart is running. Retry calls it again. */
	async function startDeparture() {
		if (departure === undefined) return;
		unready = undefined;
		try {
			await departure.start();
		} catch (cause) {
			log.warn(new Error('Starting the departure wire failed.', { cause }));
			if (!known) unready = cause instanceof Error ? cause.message : String(cause);
		}
	}

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// host's directory. A folder that cannot be opened is shown as that
	// refusal; nothing else is opened in its place.
	//
	// Inside Epicenter, the listener and a status from the host come before
	// the folder opens, so nothing is editable while a quit or restart may be
	// running. A failure keeps the page here, unopened, with Retry; a later
	// nudge or focus that reads the status opens it too.
	if (departure !== undefined) {
		void startDeparture();
		void departure.whenKnown().then(
			() => {
				known = true;
				unready = undefined;
			},
			() => {},
		);
	}
	const opening = openTodosPage(departure, openTodosFolder);

	// Teardown, not a choice about input. It runs when SvelteKit destroys this
	// page, which TodosView's beforeNavigate refuses while anything is
	// unsaved; closing or hiding the window, quitting, and a host restart
	// never run it. `close` saves what may save and names what it could not.
	onDestroy(() => {
		departure?.destroy();
		void opening.then((opened) => opened.data?.close()).catch(() => {});
	});
</script>

{#snippet refused(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the todos folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
	</Empty.Root>
{/snippet}

{#await opening}
	{#if unready !== undefined}
		<Empty.Root class="h-dvh">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Todos is waiting for Epicenter</Empty.Title>
			<Empty.Description>
				Todos opens once it can tell whether Epicenter is quitting or restarting, so nothing you type is lost to one. {unready}
			</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void startDeparture()}>Retry</Button>
		</Empty.Root>
	{:else}
		<Loading class="h-dvh" label="Opening your todos…" />
	{/if}
{:then opened}
	{#if opened.error}
		{@render refused(opened.error.message)}
	{:else}
		<TodosView todos={opened.data} {departure} />
	{/if}
{:catch error}
	{@render refused(error instanceof Error ? error.message : String(error))}
{/await}

<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Captures } from '$lib/captures.svelte.js';
	import type { Notice } from '$lib/draft.svelte.js';
	import type { Departure } from '$lib/platform/departure.svelte.js';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import Workspace, { type Place } from './Workspace.svelte';

	let {
		captures,
		departure,
	}: {
		captures: Captures;
		/** The host's question before it quits or restarts; none in a browser. */
		departure: Departure | undefined;
	} = $props();

	// One route: the timeline, Files, the recovery screen, or one capture as
	// either workspace edits it. The page and its drafts stay mounted across
	// all of them, so moving between captures and workspaces never drops
	// unsaved input.
	const place = $derived.by((): Place => {
		const params = page.url.searchParams;
		// An empty stem (`captures/.md`) is still a capture to open.
		const capture = params.get('capture');
		if (capture !== null) return { kind: 'capture', stem: capture };
		const file = params.get('file');
		if (file !== null) return { kind: 'file', stem: file };
		if (params.has('files')) return { kind: 'files' };
		if (params.has('recover')) return { kind: 'recover' };
		return { kind: 'timeline' };
	});
	const draft = $derived(
		place.kind === 'capture' || place.kind === 'file' ? captures.draft(place.stem) : undefined,
	);
	/** The workspace the place belongs to, for its navigation. */
	const workspace = $derived(place.kind === 'files' || place.kind === 'file' ? 'files' : 'timeline');

	/** The capture just added from the timeline, so its page starts at Add a thought. */
	let created = $state<string>();

	function go(target: Place, options: { created?: boolean } = {}) {
		created = options.created && target.kind === 'capture' ? target.stem : undefined;
		const query =
			target.kind === 'capture'
				? `?capture=${encodeURIComponent(target.stem)}`
				: target.kind === 'file'
					? `?file=${encodeURIComponent(target.stem)}`
					: target.kind === 'files'
						? '?files'
						: target.kind === 'recover'
							? '?recover'
							: '';
		void goto(`${resolve('/')}${query}`);
	}

	// Leaving would lose something: unsaved or unsent input, or any open
	// capture once the folder is closed and nothing can be saved again.
	const mustStay = $derived(captures.unsettled > 0 || captures.folderStopped);

	// Drafts live only in this page. A reload, a tab close, or a navigation out
	// of the app is held back here; quitting the desktop app asks below.
	beforeNavigate((navigation) => {
		if (!mustStay) return;
		if (navigation.willUnload || navigation.to?.route.id !== page.route.id)
			navigation.cancel();
	});

	$effect(() => departure?.onHostStopped(() => captures.markServiceStopped()));

	/** Quitting or restarting, in the words the person chose. */
	const leaving = $derived(departure?.intent === 'restart' ? 'restart' : 'quit');

	// Recovery for a change hint that never arrived.
	$effect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void captures.refresh();
		}, 30_000);
		return () => clearInterval(timer);
	});

	const commitProblem = $derived.by(() => {
		const last = captures.git.lastCommit;
		if (last === undefined) return undefined;
		if (last.status === 'failed') return last.error;
		if (last.status === 'blocked') return last.reason;
		if (last.status === 'branchMoved') return 'The branch moved while committing.';
		return undefined;
	});
	let committing = $state(false);
	async function retryCommit() {
		committing = true;
		try {
			const outcome = await captures.commit();
			if (outcome.status === 'committed' || outcome.status === 'unchanged')
				toast.success('History is up to date');
			// No answer came back, so the snapshot cannot say what happened.
			else if (outcome.status === 'unconfirmed')
				toast.warning('The commit was not confirmed', { description: outcome.error });
		} finally {
			committing = false;
		}
	}

	const NOTICE_STATUS = {
		unconfirmed: 'Save not confirmed',
		failed: 'Save failed',
		deletion: 'Delete not confirmed',
		removed: 'File removed',
	} satisfies Record<Notice['kind'], string>;

	const status = $derived.by((): { text: string; tone: 'quiet' | 'pending' | 'problem' } => {
		if (captures.folderStopped) return { text: 'Saving unavailable', tone: 'problem' };
		if (draft?.saving) return { text: 'Saving…', tone: 'quiet' };
		if (draft?.notice) return { text: NOTICE_STATUS[draft.notice.kind], tone: 'problem' };
		if (captures.unsettled > 0)
			return {
				text: draft?.unsettled ? 'Not saved yet' : `${captures.unsettled} not saved`,
				tone: 'pending',
			};
		return { text: 'Saved', tone: 'quiet' };
	});
</script>

<!-- Returning to the app is a refresh boundary for files. -->
<svelte:window
	onfocus={() => void captures.refresh()}
	onbeforeunload={(event) => {
		if (mustStay) event.preventDefault();
	}}
	onkeydown={(event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && mustStay) {
			// The leave prompt is the webview's to show or not; refusing the
			// shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: some text is not saved', {
				description: 'Finish, resolve, or copy it first, then reload.',
			});
		}
	}}
/>

<header class="border-b">
	<div class="mx-auto flex h-12 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
		<!-- Workspaces: each opens its own list. A capture opened from one is edited the way that one edits it. -->
		<nav aria-label="Workspaces" class="-ml-2.5 flex items-center gap-1">
			<Button
				variant={workspace === 'timeline' ? 'secondary' : 'ghost'}
				size="sm"
				aria-current={place.kind === 'timeline' ? 'page' : undefined}
				onclick={() => go({ kind: 'timeline' })}>Timeline</Button
			>
			<Button
				variant={workspace === 'files' ? 'secondary' : 'ghost'}
				size="sm"
				aria-current={place.kind === 'files' ? 'page' : undefined}
				onclick={() => go({ kind: 'files' })}>Files</Button
			>
		</nav>
		<span
			role="status"
			class={{
				'text-xs': true,
				'text-muted-foreground': status.tone === 'quiet',
				'font-medium': status.tone !== 'quiet',
				'text-destructive': status.tone === 'problem',
			}}
		>{status.text}</span>
	</div>
</header>

<main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pb-16 pt-6 sm:px-6">
	{#if departure?.fenced && !departure.prompt}
		<Alert.Root aria-label={leaving === 'restart' ? 'Restarting' : 'Quitting'}>
			<Alert.Title>{leaving === 'restart' ? 'Epicenter is restarting' : 'Epicenter is quitting'}</Alert.Title>
			<Alert.Description>
				{#if departure.answered === 'cancel'}
					You chose to keep working. Your text is kept; editing resumes once Epicenter confirms it is staying open.
				{:else if departure.answered === 'ready' || departure.vote === 'discarded'}
					Waiting for Epicenter to {leaving}. Nothing here is changed or discarded unless it does.
				{:else}
					Saving what saves on its own. Editing is paused until Epicenter {leaving === 'restart' ? 'restarts' : 'quits'} or stays open.
				{/if}
			</Alert.Description>
			{#if departure.answerProblem}
				<p role="status" class="mt-2 text-foreground">Epicenter did not receive this window's answer, so editing stays paused: {departure.answerProblem}</p>
				<div class="mt-2"><Button variant="outline" size="sm" onclick={() => departure.retry()}>Check again</Button></div>
			{/if}
		</Alert.Root>
	{/if}
	{#if captures.folderStopped}
		<Alert.Root variant="destructive">
			<Alert.Title>Epicenter closed this folder</Alert.Title>
			<Alert.Description>Saving cannot be confirmed from this window. Your text is still here. Open each capture with unsaved text and copy or download it, then restart Epicenter. Reloading or quitting now discards it.</Alert.Description>
		</Alert.Root>
	{:else if captures.serviceStopped}
		<Alert.Root>
			<Alert.Title>Epicenter's background service stopped</Alert.Title>
			<Alert.Description>Captures still save to the folder from this window. Reloading it, or exporting captures from an account, may not work until Epicenter restarts.</Alert.Description>
		</Alert.Root>
	{/if}
	{#if captures.listProblem}
		<Alert.Root variant="destructive">
			<Alert.Title>The captures folder could not be read</Alert.Title>
			<Alert.Description>What is listed here may be out of date. Text you have typed in this window is still here.</Alert.Description>
			<div class="mt-2 text-foreground"><Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button></div>
			<TechnicalDetails detail={captures.listProblem} />
		</Alert.Root>
	{/if}
	{#if commitProblem}
		<Alert.Root aria-label="History problem">
			<Alert.Title>History was not recorded</Alert.Title>
			<Alert.Description>Your captures are saved as files. Only the Git commit that records them did not complete, so the latest changes are not in history yet.</Alert.Description>
			<div class="mt-2"><Button variant="outline" size="sm" disabled={committing} onclick={retryCommit}>{committing ? 'Committing…' : 'Try the commit again'}</Button></div>
			<TechnicalDetails detail={commitProblem} />
		</Alert.Root>
	{/if}

	<div>
		<Workspace {captures} {place} {created} {go} />
	</div>
</main>

{#if departure}
	<!-- One question per round. Closing it is Keep working. -->
	<Dialog.Root open={departure.prompt !== undefined} onOpenChange={(open) => { if (!open) departure.keepWorking(); }}>
		<Dialog.Content class="sm:max-w-md">
			{@const held = departure.prompt?.held ?? 0}
			<Dialog.Header>
				<Dialog.Title>{held} {held === 1 ? 'thing is' : 'things are'} not saved</Dialog.Title>
				<Dialog.Description>
					{#if captures.folderStopped}
						Epicenter can no longer save from this window. {leaving === 'restart' ? 'Restarting' : 'Quitting'} now discards the text still open here. Keep working to copy or download it first.
					{:else}
						Some text could not be saved, or was typed and not added yet. {leaving === 'restart' ? 'Restarting' : 'Quitting'} now discards it. Keep working to finish, resolve, or copy it.
					{/if}
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer>
				<Button variant="outline" onclick={() => departure.keepWorking()}>Keep working</Button>
				<Button variant="destructive" onclick={() => departure.discard()}>{leaving === 'restart' ? 'Discard and restart' : 'Discard and quit'}</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}

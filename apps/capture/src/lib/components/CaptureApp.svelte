<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { Captures } from '$lib/captures.svelte.js';
	import type { Notice } from '$lib/draft.svelte.js';
	import type { CaptureHost } from '$lib/platform/types.js';
	import CaptureDetail from './CaptureDetail.svelte';
	import Recovery from './Recovery.svelte';
	import TechnicalDetails from './TechnicalDetails.svelte';
	import Timeline from './Timeline.svelte';

	let { host, captures }: { host: CaptureHost; captures: Captures } = $props();

	// One route, three views. The page and its drafts stay mounted across all
	// of them, so moving between captures never drops unsaved input.
	const stem = $derived(page.url.searchParams.get('capture'));
	const recovering = $derived(page.url.searchParams.has('recover'));
	const draft = $derived(stem === null ? undefined : captures.draft(stem));

	$effect(() => {
		if (stem !== null && captures.has(stem) && captures.draft(stem) === undefined)
			untrack(() => captures.open(stem));
	});

	/** The capture just added from the timeline, so its page starts at Add a thought. */
	let created = $state<string>();

	function show(target: { capture?: string; recover?: true; created?: true } = {}) {
		created = target.created ? target.capture : undefined;
		// An empty stem (`captures/.md`) is still a capture to open.
		const query = target.capture !== undefined
			? `?capture=${encodeURIComponent(target.capture)}`
			: target.recover
				? '?recover'
				: '';
		return goto(`${resolve('/')}${query}`);
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

	$effect(() => host.onServiceStopped(() => captures.markServiceStopped()));
	$effect(() =>
		host.onQuitRequested(async (answer) => {
			const remaining = await captures.settleAll();
			if (remaining === 0) {
				await answer('proceed');
				return;
			}
			confirmationDialog.open({
				title: `${remaining} ${remaining === 1 ? 'thing is' : 'things are'} not saved`,
				description: captures.folderStopped
					? 'Epicenter can no longer save from this window. Quitting discards the text still open here. Keep working to copy or download it first.'
					: 'Some text could not be saved, or was typed and not added yet. Quitting now discards it. Keep working to finish, resolve, or copy it.',
				confirm: { text: 'Discard and quit', variant: 'destructive' },
				cancel: { text: 'Keep working' },
				onConfirm: async () => {
					await captures.close({ discard: true });
					await answer('proceed');
				},
				onCancel: () => void answer('cancel'),
			});
		}),
	);

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
		changed: 'Changed elsewhere',
		invalid: 'Changed elsewhere',
		unreadable: 'Cannot be read',
	} satisfies Record<Notice['kind'], string>;

	const status = $derived.by((): { text: string; tone: 'quiet' | 'pending' | 'problem' } => {
		if (captures.folderStopped) return { text: 'Saving unavailable', tone: 'problem' };
		if (draft?.saving) return { text: 'Saving…', tone: 'quiet' };
		if (draft?.notice) return { text: NOTICE_STATUS[draft.notice.kind], tone: 'problem' };
		if (captures.unsettled > 0)
			return {
				text: draft?.dirty ? 'Unsaved changes' : `${captures.unsettled} not saved`,
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
		{#if recovering || stem !== null}
			<Button variant="ghost" size="sm" class="-ml-2.5" onclick={() => show()}><span aria-hidden="true">←</span> Timeline</Button>
		{:else}
			<span class="text-sm font-semibold">Capture</span>
		{/if}
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
	{#if host.quitProtectionProblem}
		<Alert.Root>
			<Alert.Description>{host.quitProtectionProblem}</Alert.Description>
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
		{#if recovering}
			<Recovery {captures} onOpen={(capture) => show({ capture })} />
		{:else if stem !== null}
			{#if draft && draft.mode.kind !== 'opening'}
				{#key draft}
					<CaptureDetail {draft} {captures} {stem} focusNewThought={created === stem} onBack={() => show()} onOpen={(capture) => show({ capture })} />
				{/key}
			{:else if draft || captures.has(stem)}
				<!-- Its saved file is listed; the editor over it is opening. -->
				<Loading label="Opening…" />
			{:else}
				{@const reason = captures.unreadableReason(stem)}
				<Empty.Root role="alert">
					<Empty.Header>
						{#if reason !== undefined}
							<Empty.Title>This capture's file cannot be read</Empty.Title>
							<Empty.Description>It is still in the folder, and this window did not write to it. Repair it with another program, then check again.</Empty.Description>
						{:else if captures.loaded}
							<Empty.Title>No capture named {stem}.md</Empty.Title>
							<Empty.Description>The folder has no file with this name. It may have been removed or renamed outside this window.</Empty.Description>
						{:else}
							<Empty.Title>This capture cannot be opened yet</Empty.Title>
							<Empty.Description>The captures folder has not been read.</Empty.Description>
						{/if}
					</Empty.Header>
					<Empty.Content>
						<div class="flex flex-wrap justify-center gap-2">
							<Button variant="outline" size="sm" onclick={() => captures.refresh()}>Check again</Button>
							<Button variant="outline" size="sm" onclick={() => show()}>Back to timeline</Button>
						</div>
						{#if reason !== undefined}<TechnicalDetails detail={reason} />{/if}
					</Empty.Content>
				</Empty.Root>
			{/if}
		{:else}
			<Timeline
				{captures}
				onOpen={(capture) => show({ capture })}
				onCreated={(capture) => show({ capture, created: true })}
				onRecover={() => show({ recover: true })}
			/>
		{/if}
	</div>
</main>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '$lib/auth.svelte.js';
	import type { VocabTables } from '$lib/data.js';
	import type { ImportCount, ImportReport } from '$lib/legacy-import.js';

	// Earlier Vocab saved words to an account and chats to a device store. This
	// version does not read either on its own, so it says where they are and
	// copies them only when asked. The old stores are never written.
	let { tables }: { tables: VocabTables } = $props();

	let pending = $state(false);
	let problem = $state('');
	let report = $state.raw<(ImportReport & { otherAccountChats: number }) | null>(null);
	const failed = $derived(
		report ? [...report.words.failed, ...report.chats.failed, ...report.messages.failed] : [],
	);

	async function run() {
		const { account } = auth.getState();
		if (!account || pending) return;
		pending = true;
		problem = '';
		try {
			// Loaded only here: the running app carries no code for the old stores.
			const [{ readLegacy }, { importLegacy }] = await Promise.all([
				import('$lib/legacy-source.js'),
				import('$lib/legacy-import.js'),
			]);
			const { otherAccountChats, ...rows } = await readLegacy(account);
			report = { ...(await importLegacy(tables, rows)), otherAccountChats };
		} catch (cause) {
			problem = extractErrorMessage(cause);
		} finally {
			pending = false;
		}
	}
	async function signIn() {
		problem = '';
		const { error } = await auth.startSignIn();
		if (error) problem = error.message;
	}
	const line = (noun: string, count: ImportCount) =>
		`${count.copied} ${noun} copied, ${count.alreadyHere} already here${count.failed.length ? `, ${count.failed.length} not copied` : ''}`;
</script>

<section class="space-y-2 rounded-lg border p-4 text-sm" aria-label="Words from earlier Vocab">
	<h3 class="font-semibold">Words and chats from earlier Vocab</h3>
	<p class="text-muted-foreground">
		Earlier versions of Vocab saved words to your account and chats to this browser under that account. They are not shown here automatically, and they are unchanged where they were saved. Importing copies what this browser holds of them into your words and chats. Nothing is removed from the earlier storage, and importing again adds nothing twice and leaves your notes and stages as they are.
	</p>
	{#if auth.state.status === 'signed-out'}
		<p class="text-muted-foreground">Sign in to the account they were saved under to import them.</p>
		<Button variant="outline" size="sm" onclick={signIn}>Sign in to import</Button>
	{:else}
		<Button variant="outline" size="sm" disabled={pending} onclick={run}>{pending ? 'Importing…' : report ? 'Import again' : 'Import from earlier Vocab'}</Button>
	{/if}
	{#if problem}<p role="alert" class="text-destructive">The import did not finish: {problem} What was already copied is kept; importing again continues.</p>{/if}
	{#if report}
		<ul role="status" class="space-y-1">
			<li>{line('words', report.words)}</li>
			<li>{line('chats', report.chats)}</li>
			<li>{line('messages', report.messages)}</li>
			{#if report.otherAccountChats > 0}
				<li>{report.otherAccountChats} {report.otherAccountChats === 1 ? 'chat belongs' : 'chats belong'} to another account on this browser and {report.otherAccountChats === 1 ? 'was' : 'were'} left where {report.otherAccountChats === 1 ? 'it is' : 'they are'}.</li>
			{/if}
		</ul>
		{#if failed.length > 0}
			<details class="text-xs text-destructive">
				<summary class="cursor-pointer">{failed.length} could not be copied. They are still in the earlier storage.</summary>
				<ul class="mt-1 space-y-1">{#each failed as item}<li class="break-words"><code>{item.id}</code>: {item.reason}</li>{/each}</ul>
			</details>
		{/if}
	{/if}
</section>

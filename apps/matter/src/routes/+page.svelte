<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import FolderGrid from '$lib/components/FolderGrid.svelte';
	import { openVault, type Vault } from '$lib/vault.svelte';

	let vault = $state<Vault>();
	let opening = $state(false);
	let openError = $state<string>();

	// The WHERE filter lives here, where the live vault is: the page calls its
	// `matchingNames` directly (no capability handed into the grid) and gives the grid the
	// matched row names as data. `matchedNames === undefined` means no active filter.
	let whereText = $state('');
	let matchedNames = $state<Set<string>>();
	let filterError = $state<string>();
	const view = $derived(vault?.read.view);

	async function openFolder() {
		opening = true;
		openError = undefined;
		try {
			const opened = await openVault();
			if (opened) {
				vault = opened;
				whereText = ''; // a new folder starts unfiltered
			}
		} catch (error) {
			openError = error instanceof Error ? error.message : String(error);
		} finally {
			opening = false;
		}
	}

	// Drive the open vault's OS watcher: start when a vault is set, stop (and
	// unwatch the old folder) when it is replaced or the page unmounts.
	$effect(() => {
		if (vault) return vault.watch();
	});

	// Resolve the WHERE clause to matched row names against the mirror. Debounced, and
	// re-run when the folder's data changes (so an edit updates membership), which also lets
	// the reconcile fired by that edit land first. A bad clause surfaces in `filterError`
	// and keeps the last good names.
	$effect(() => {
		const v = vault;
		const clause = whereText.trim();
		if (v) void v.read; // re-run when rows change so an edit updates filter membership
		if (!v || !clause) {
			matchedNames = undefined;
			filterError = undefined;
			return;
		}
		let cancelled = false;
		const handle = setTimeout(async () => {
			const { data, error } = await v.matchingNames(clause);
			if (cancelled) return; // a newer clause, a data change, or a folder swap won
			if (error) filterError = error.message;
			else {
				matchedNames = data;
				filterError = undefined;
			}
		}, 200);
		return () => {
			cancelled = true;
			clearTimeout(handle);
		};
	});
</script>

<main class="flex h-screen flex-col">
	<div class="flex min-h-12 items-center gap-3 border-b px-4 py-2">
		<Button
			onclick={openFolder}
			disabled={opening}
			variant="outline"
			size="sm"
		>
			{#if opening}
				<Spinner class="size-3.5" />
				Opening
			{:else}
				<FolderOpenIcon />
				{vault ? 'Open another folder' : 'Open folder'}
			{/if}
		</Button>
		{#if vault}
			<Badge variant="id" class="max-w-[60vw] truncate">{vault.name}</Badge>
		{/if}
		{#if openError}
			<span class="text-xs text-destructive">{openError}</span>
		{/if}
		{#if vault && view?.mode === 'modeled'}
			<!-- WHERE filter: a SQL predicate run against matter.sqlite; the grid below
			     narrows to the matching rows, still typed and editable. -->
			<div class="ml-auto flex items-center gap-1.5">
				<span
					class="font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					where
				</span>
				<Input
					bind:value={whereText}
					placeholder="status = 'ready'"
					spellcheck={false}
					autocapitalize="off"
					autocomplete="off"
					autocorrect="off"
					aria-invalid={Boolean(filterError)}
					aria-label="Filter rows with a SQL WHERE clause"
					title={filterError}
					class={[
						'h-8 w-72 font-mono text-xs',
						filterError && 'border-destructive focus-visible:ring-destructive/30',
					]}
				/>
			</div>
		{/if}
	</div>

	{#if vault}
		{#if vault.error}
			<Empty.Root class="flex-1 border-0">
				<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
				<Empty.Title>Couldn't watch {vault.name}</Empty.Title>
				<Empty.Description>{vault.error}</Empty.Description>
			</Empty.Root>
		{:else if vault.status === 'loading'}
			<Empty.Root class="flex-1 border-0" aria-live="polite">
				<Empty.Media><Spinner class="size-5 text-muted-foreground" /></Empty.Media>
				<Empty.Title>Loading {vault.name}</Empty.Title>
			</Empty.Root>
		{:else}
			{#if vault.writeError}
				<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0 py-2">
					<Alert.Description class="text-xs">
						Couldn't save: {vault.writeError}
					</Alert.Description>
				</Alert.Root>
			{/if}
			<FolderGrid {vault} {matchedNames} />
		{/if}
	{:else}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon"><FolderOpenIcon /></Empty.Media>
			<Empty.Title>Open a folder</Empty.Title>
			<Empty.Description>Choose a markdown folder to inspect its frontmatter.</Empty.Description>
			<Empty.Content>
				<Button onclick={openFolder} disabled={opening}>
					{#if opening}
						<Spinner class="size-3.5" />
						Opening
					{:else}
						<FolderOpenIcon />
						Open folder
					{/if}
				</Button>
			</Empty.Content>
		</Empty.Root>
	{/if}
</main>

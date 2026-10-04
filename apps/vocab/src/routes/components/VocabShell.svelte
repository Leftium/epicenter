<script lang="ts">
	import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
	import { createInferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import { toHostedCatalog } from '@epicenter/constants/ai-providers';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { onDestroy } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { auth } from '$lib/auth.svelte.js';
	import type { ChatsState } from '$lib/chat/chats.svelte.js';
	import { type FocusItem, VOCAB_MODEL, type VocabFolder } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';
	import { openVocabInference } from '$lib/inference.js';
	import AccountMenu from './AccountMenu.svelte';
	import ConversationView from './ConversationView.svelte';
	import FocusWords from './FocusWords.svelte';
	import WordsView from './WordsView.svelte';

	let { vocab }: { vocab: { folder: VocabFolder; entries: EntriesState; chats: ChatsState } } = $props();
	/* svelte-ignore state_referenced_locally */
	const { folder, entries, chats } = vocab;

	// The account adds hosted models and nothing else. It is read once:
	// sign-in and sign-out replace this page, and a change made in another tab
	// is offered as a reload below. The folder, the endpoints connected on this
	// device, and the chosen model are the same either way.
	const account = auth.getState().account;
	const departure = new AbortController();
	const sources = openVocabInference(account);
	const catalog = createInferenceCatalog({ ai: sources, signal: departure.signal, hostedModels: toHostedCatalog([VOCAB_MODEL]) });
	const selections = createBrowserInferenceSelections('vocab');
	const accountChanged = $derived(auth.state.account?.principalId !== account?.principalId || auth.state.account?.authorityId !== account?.authorityId);

	let selectedChatId = $state<string | null>(null);
	let view = $state<'words' | 'chat'>('words');
	let historyOpen = $state(false);
	let focusOpen = $state(false);
	let openingId = $state<string | null>(null);
	let starting = $state(false);
	const selectedChat = $derived(chats.chats.find((chat) => chat.id === selectedChatId));
	const unreadable = $derived([...entries.unreadable, ...chats.unreadable]);
	const loadError = $derived(entries.loadError ?? chats.loadError);
	let conversation = $state<ConversationView>();
	// A chat switch held back because the open chat has an unsaved message.
	let heldSwitch = $state<(() => void) | null>(null);

	/**
	 * Save the focus as a new chat, then show it. The opening it requests
	 * starts only once the folder holds the chat's file. Answers whether the
	 * chat started, so Words keeps the selection when it did not.
	 */
	async function begin(focus: FocusItem[], leaving = false): Promise<boolean> {
		// Switching chats disposes the open one, so an unsaved message needs a yes first.
		if (!leaving && conversation?.hasUnsaved()) {
			heldSwitch = () => void begin(focus, true);
			return false;
		}
		if (starting) return false;
		starting = true;
		const { data: chat, error } = await chats.start(focus);
		starting = false;
		if (error !== null) {
			toast.error('The chat was not started', { description: `${error.message} The tutor has not been asked.` });
			return false;
		}
		selectedChatId = chat.id;
		openingId = chat.id;
		view = 'chat';
		return true;
	}
	function openChat(id: string) {
		if (id === selectedChatId) {
			historyOpen = false;
			view = 'chat';
			return;
		}
		const open = () => {
			selectedChatId = id;
			openingId = null;
			historyOpen = false;
			view = 'chat';
		};
		if (conversation?.hasUnsaved()) heldSwitch = open;
		else open();
	}
	onDestroy(() => {
		departure.abort();
		selections[Symbol.dispose]();
		void sources.then(({ account, connections }) => Promise.allSettled([account?.close(), connections?.close()]));
	});

	// A note typed and not yet saved, a word whose save waits for a choice, or
	// repair text lives only in this page. Leaving it asks first; the open
	// chat's unsaved message asks on its own.
	beforeNavigate((navigation) => {
		if (entries.unsettled === 0) return;
		if (navigation.willUnload || navigation.to?.route.id !== page.route.id) navigation.cancel();
	});
</script>

<svelte:window onbeforeunload={(event) => { if (entries.unsettled > 0) event.preventDefault(); }} />

<div class="flex h-dvh min-w-0 flex-col">
	<!-- Wraps on a narrow screen: the controls move under the views, right-aligned, and nothing is clipped. -->
	<header class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b px-4 py-2">
		<div class="flex items-center gap-2"><h1 class="text-lg font-semibold">Vocab</h1><Button size="sm" variant={view === 'words' ? 'default' : 'ghost'} onclick={() => view = 'words'}>Words</Button><Button size="sm" variant={view === 'chat' ? 'default' : 'ghost'} disabled={chats.chats.length === 0} onclick={() => { view = 'chat'; historyOpen = true; }}>Chat</Button></div>
		<div class="ml-auto flex items-center gap-1"><LightSwitch variant="ghost" /><AccountMenu /></div>
	</header>
	{#if loadError}
		<div role="alert" class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-destructive">
			<span>Vocab could not read its folder in this browser: {loadError}</span>
			<Button variant="ghost" size="sm" onclick={() => { void entries.refresh(); void chats.refresh(); }}>Read again</Button>
		</div>
	{/if}
	{#if unreadable.length > 0}
		<details class="border-b px-3 py-2 text-xs">
			<summary class="cursor-pointer text-destructive">{unreadable.length} saved {unreadable.length === 1 ? 'file is' : 'files are'} not shown because Vocab cannot read {unreadable.length === 1 ? 'it' : 'them'}. Nothing was changed or removed.</summary>
			<ul class="mt-2 space-y-1">
				{#each unreadable as file (file.path)}<li class="break-words"><code>{file.path}</code>: {file.reason}</li>{/each}
			</ul>
		</details>
	{/if}
	{#if accountChanged}
		<div role="status" class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
			<span>Your sign-in changed in another tab. Reload to use it for the tutor. Your words and chats are not affected.</span>
			<Button variant="ghost" size="sm" onclick={() => location.reload()}>Reload</Button>
		</div>
	{/if}
	{#if heldSwitch}
		<div role="alert" class="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-destructive">
			<span>The open chat has a message that is not saved. Leaving it now can lose that message.</span>
			<div class="flex gap-1">
				<Button variant="ghost" size="sm" onclick={() => { heldSwitch = null; view = 'chat'; }}>Stay</Button>
				<Button variant="ghost" size="sm" onclick={() => { const leave = heldSwitch; heldSwitch = null; leave?.(); }}>Leave anyway</Button>
			</div>
		</div>
	{/if}
	<div class="min-h-0 flex-1" class:hidden={view !== 'words'}><WordsView {entries} {starting} onStart={begin} /></div>
	<div class="flex min-h-0 flex-1" class:hidden={view !== 'chat'}>
		<aside class="hidden w-56 shrink-0 overflow-y-auto border-r p-3 md:block" aria-label="Chat history">
			<h2 class="mb-2 text-sm font-semibold">Chats in this browser</h2>
			{#each chats.chats as chat (chat.id)}<Button class="mb-1 w-full justify-start truncate" variant={chat.id === selectedChatId ? 'secondary' : 'ghost'} onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}
		</aside>
		<div class="flex min-w-0 flex-1 flex-col">
			<div class="flex items-center gap-2 border-b px-3 py-2 md:hidden"><Button size="sm" variant="outline" onclick={() => historyOpen = !historyOpen}>History</Button><Button size="sm" variant="outline" onclick={() => focusOpen = !focusOpen}>Focus</Button></div>
			{#if historyOpen || !selectedChatId}<nav class="max-h-44 overflow-y-auto border-b p-2 md:hidden" aria-label="Chat history">{#each chats.chats as chat (chat.id)}<Button class="w-full justify-start" variant="ghost" onclick={() => openChat(chat.id)}>{chat.title}</Button>{/each}</nav>{/if}
			{#if focusOpen && selectedChat}<div class="border-b p-3 md:hidden"><FocusWords focus={selectedChat.focus} {entries} /></div>{/if}
			{#if !selectedChatId}<p class="m-auto text-center text-muted-foreground">Choose a chat from history.</p>{/if}
			{#if selectedChatId && selectedChat}
				{#key selectedChatId}<ConversationView bind:this={conversation} chatId={selectedChatId} messages={folder.tables.messages} {catalog} {selections} {entries} focus={selectedChat.focus} visible={view === 'chat'} startOpening={openingId === selectedChatId} onOpeningStarted={() => openingId = null} />{/key}
			{/if}
		</div>
		<aside class="hidden w-60 shrink-0 overflow-y-auto border-l p-3 md:block" aria-label="Focus words">
			{#if selectedChat}<FocusWords focus={selectedChat.focus} {entries} />{/if}
		</aside>
	</div>
</div>

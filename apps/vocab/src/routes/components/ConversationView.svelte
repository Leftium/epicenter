<script lang="ts">
	import { agentMessageText } from '@epicenter/agent';
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Chat from '@epicenter/ui/chat';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { onDestroy, onMount, untrack } from 'svelte';
	import type { AgentMessage } from '@epicenter/agent';
	import { auth } from '$lib/auth.svelte.js';
	import { createVocabChat } from '$lib/chat/session.svelte.js';
	import type { ChatHistoryData } from '$lib/data.js';
	import type { PersistenceCapability } from '@epicenter/app/store';
	import type { createEntriesState } from '$lib/entries.svelte.js';
	import type { InferenceCatalog } from '@epicenter/app-shell/inference-picker';
	import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
	import { useReading } from '$lib/reading-preference.js';
	import DictationButton from './DictationButton.svelte';
	import PhraseCapture from './PhraseCapture.svelte';
	import ReadingMarkdown from './ReadingMarkdown.svelte';
	import ReadingText from './ReadingText.svelte';

	const accountManagementUrl = auth.accountManagementUrl;
	const openConnection = getConnectionScreen();
	// The route keys this whole surface on Account identity, like its inference client.
	const account = untrack(() => {
		const state = auth.state;
		return state.status === 'signed-out' ? undefined : state.account;
	});

	let {
		conversationId,
		messages,
		persistence,
		accountKey,
		catalog,
		selections,
		entries,
		focus,
		visible,
		startOpening = false,
		onOpeningStarted = () => {},
	}: {
		conversationId: string;
		messages: ChatHistoryData['tables']['messages'];
		persistence: PersistenceCapability;
		accountKey: string;
		catalog: InferenceCatalog;
		selections: InferenceSelections;
		entries: ReturnType<typeof createEntriesState>;
		focus: readonly { text: string }[];
		visible: boolean;
		startOpening?: boolean;
		onOpeningStarted?: () => void;
	} = $props();

	// The parent keys this component by conversation ID. Its loop and draft
	// end when another chat is selected; dictation ends sooner when Chat hides.
	/* svelte-ignore state_referenced_locally */
	const chat = createVocabChat({ messages, persistence, accountKey, conversationId, focus, catalog, selections });

	/**
	 * Whether leaving this chat would drop a message its storage has not
	 * confirmed. The shell asks before it switches chats.
	 */
	export function hasUnsaved() {
		return chat.unsaved.length > 0;
	}

	const reading = useReading();
	// The element holding the messages; phrase capture listens inside it.
	let list = $state<HTMLElement | null>(null);
	// A reopened chat can contain rows accepted before a failed save. The
	// current loop cannot mark those rows, so storage confirms the history
	// before any message in it is a phrase source.
	const historyStored = $derived(persistence.get() === 'saved');

	onMount(() => {
		if (startOpening) {
			onOpeningStarted();
			void chat.retry();
		}
	});
	onDestroy(() => chat[Symbol.dispose]());

	/** Land a dictated transcript in the draft for review. */
	function appendTranscript(text: string) {
		const draft = chat.inputValue.trim();
		chat.inputValue = draft ? `${draft} ${text}` : text;
	}
	const lastMessage = $derived(chat.messages.at(-1));
	const unsavedIds = $derived(new Set(chat.unsaved.map((unsaved) => unsaved.id)));
</script>

<svelte:window onbeforeunload={(event) => { if (hasUnsaved()) event.preventDefault(); }} />

<PhraseCapture root={list} {entries} {historyStored} resetKey={`${reading.showPinyin}:${chat.messages.length}:${chat.isGenerating}`} />

{#snippet message(msg: AgentMessage, streaming: boolean)}
	{#if streaming}
		<!-- Render Markdown and readings only after the answer settles. -->
		<div class="whitespace-pre-wrap">{agentMessageText(msg)}</div>
	{:else if msg.role === 'user'}
		<div class="whitespace-pre-wrap"><ReadingText text={agentMessageText(msg)} /></div>
	{:else}
		<!-- A tutor answer is a phrase source only once storage has confirmed it:
		     an unsaved one stays readable and copyable without the marker. -->
		{@const saved = !unsavedIds.has(msg.id)}
		<div data-phrase-source={saved && historyStored ? msg.id : undefined}>
			<ReadingMarkdown content={agentMessageText(msg)} />
		</div>
		{#if saved}
			<Button class="mt-1" variant="ghost" size="xs" disabled={!historyStored} data-capture-skip data-save-phrase={msg.id}>Save a phrase</Button>
		{/if}
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 flex-1 overflow-y-auto" bind:this={list}>
		{#if chat.messages.length === 0 && !chat.streaming && !chat.isThinking}
			<div class="flex h-full items-center justify-center px-4 text-center text-muted-foreground">
				<p>The tutor is ready to open this conversation.</p>
			</div>
		{:else}
			<Chat.List>
				{#each chat.messages as msg (msg.id)}
					<Chat.Bubble variant={msg.role === 'user' ? 'sent' : 'received'}>
						<Chat.BubbleMessage>{@render message(msg, false)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{/each}
				{#if chat.streaming}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage>{@render message(chat.streaming, true)}</Chat.BubbleMessage>
					</Chat.Bubble>
				{:else if chat.isThinking}
					<Chat.Bubble variant="received"><Chat.BubbleMessage typing /></Chat.Bubble>
				{/if}
					{#if lastMessage?.role === 'user' && !chat.isGenerating && chat.unsaved.length === 0}
						<div class="flex justify-start px-2 py-1">
							<Button variant="ghost" class="text-muted-foreground" disabled={!chat.canAsk} onclick={() => chat.retry()}>
								<RotateCcwIcon class="size-3" />
								Retry answer
						</Button>
					</div>
				{/if}
			</Chat.List>
		{/if}
	</div>
	{#if chat.messages.length === 0 && focus.length > 0 && !chat.isGenerating}
		<div class="flex justify-center border-t p-2"><Button variant="outline" disabled={!chat.canAsk} onclick={() => chat.retry()}><RotateCcwIcon class="size-3" />Retry opening</Button></div>
	{/if}

	{#if chat.saveError}
		<!-- A storage failure, kept apart from tutor failures below: saving again never asks the tutor. -->
		<div role="alert" class="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-destructive">
			<span>
				{#if chat.isSaving}
					Saving again...
				{:else if chat.unsaved[0]?.role === 'user'}
					Your message is not saved on this device, so the tutor has not been asked. It can be lost if Vocab closes.
				{:else if chat.unsaved.length > 0}
					The tutor's answer is not saved on this device. It can be lost if Vocab closes.
				{:else}
					This chat is not saved on this device, so the tutor has not been asked. Save it, then ask the tutor.
				{/if}
			</span>
			<div class="flex gap-1">
				<Button variant="ghost" size="sm" disabled={chat.isSaving} onclick={() => chat.saveAgain()}>Save again</Button>
				{#if chat.unsaved.length > 0}
					<CopyButton variant="ghost" size="sm" tabindex={0} text={chat.unsaved.map(agentMessageText).join('\n\n')}>Copy</CopyButton>
				{/if}
			</div>
		</div>
	{/if}

	{#if chat.error?.code === 'Unauthorized'}
		<div role="alert" class="flex items-center justify-between border-t px-3 py-2 text-xs text-destructive">
			<span>Sign in to use Vocab chat</span>
			<Button variant="ghost" size="sm" onclick={openConnection}>Sign in</Button>
		</div>
	{:else if chat.error?.code === 'InsufficientCredits'}
		<div role="alert" class="flex items-center justify-between border-t px-3 py-2 text-xs text-destructive">
			<span>You're out of credits</span>
			{#if account && accountManagementUrl}
				<Button variant="ghost" size="sm" onclick={() => window.open(accountManagementUrl(account).href, '_blank', 'noopener')}>Upgrade</Button>
			{/if}
		</div>
	{:else if chat.visibleError}
		<div role="alert" class="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs text-destructive">
			<span>{chat.visibleError.message}</span>
			<div class="flex gap-1">
				<Button variant="ghost" size="sm" disabled={!chat.canAsk} onclick={() => chat.retry()}>Retry</Button>
				<Button variant="ghost" size="sm" onclick={() => chat.dismissError()}>Dismiss</Button>
			</div>
		</div>
	{/if}

	<div class="bg-background px-2 pt-1.5">
		<InferencePicker value={chat.target} onSelect={(target) => chat.selectTarget(target)} {catalog} disabled={chat.isGenerating} />
	</div>
	{#if !chat.canServe}
		<p class="px-3 pb-1 text-xs text-muted-foreground">Choose an available model to chat.</p>
	{/if}
	<form class="flex items-end gap-1.5 border-t bg-background px-2 py-1.5" aria-label="Chat message" aria-busy={chat.isSaving} onsubmit={(event) => { event.preventDefault(); void chat.sendMessage(); }}>
		{#if visible}<DictationButton {catalog} disabled={chat.isGenerating} onTranscript={appendTranscript} />{/if}
		<Textarea
			class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
			rows={1}
			placeholder="Reply to your tutor..."
			aria-label="Message input"
			bind:value={chat.inputValue}
			onkeydown={(event: KeyboardEvent) => {
				if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					void chat.sendMessage();
				}
			}}
		/>
		{#if chat.isGenerating}
			<Button variant="outline" size="icon-lg" type="button" onclick={() => chat.stop()} aria-label="Stop generating"><SquareIcon /></Button>
		{:else}
			<Button type="submit" size="icon-lg" disabled={!chat.canSend} aria-label="Send message"><SendIcon /></Button>
		{/if}
	</form>
</div>

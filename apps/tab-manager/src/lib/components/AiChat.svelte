<script lang="ts">
	import { aiChatState } from '$lib/state/chat.svelte';
	import { confirmationDialog } from '$lib/components/ConfirmationDialog.svelte';
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import * as Chat from '@epicenter/ui/chat';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import * as Empty from '@epicenter/ui/empty';
	import ModelCombobox from '$lib/components/ModelCombobox.svelte';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import MessageSquarePlusIcon from '@lucide/svelte/icons/message-square-plus';
	import CheckIcon from '@lucide/svelte/icons/check';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import SquareIcon from '@lucide/svelte/icons/square';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import XIcon from '@lucide/svelte/icons/x';

	let inputValue = $state('');

	/** Tracks dismissed error to avoid re-showing the same one. */
	let dismissedError = $state<string | null>(null);
	const conversationPicker = useCombobox();
	let conversationSearch = $state('');

	const filteredConversations = $derived(
		conversationSearch
			? aiChatState.conversations.filter((c) =>
					c.title.toLowerCase().includes(conversationSearch.toLowerCase()),
				)
			: aiChatState.conversations,
	);
	function send() {
		const content = inputValue.trim();
		if (!content) return;
		inputValue = '';
		aiChatState.sendMessage(content);
	}

	/** Extract text content from a message's parts array. */
	function getTextContent(
		parts: Array<{ type: string; content?: string }>,
	): string {
		return parts
			.filter((p) => p.type === 'text')
			.map((p) => p.content)
			.join('');
	}
	/** Format a timestamp as a short relative time string. */
	function formatRelativeTime(ms: number): string {
		const seconds = Math.floor((Date.now() - ms) / 1000);
		if (seconds < 60) return 'now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}d`;
		return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	}

	/**
	 * Show loading dots when waiting for assistant content.
	 *
	 * Covers the gap between 'submitted' (request sent) and first visible
	 * assistant token. Without this, dots flash away when status transitions
	 * to 'streaming' before any text is actually rendered.
	 */
	const showLoadingDots = $derived(
		aiChatState.status === 'submitted' ||
			(aiChatState.status === 'streaming' &&
				aiChatState.messages.at(-1)?.role !== 'assistant'),
	);

	/** Show regenerate button when idle and last message is from assistant. */
	const showRegenerate = $derived(
		aiChatState.status === 'ready' &&
			aiChatState.messages.at(-1)?.role === 'assistant',
	);

	/** Active conversation title for the header bar. */
	const activeTitle = $derived(
		aiChatState.activeConversation?.title ?? 'New Chat',
	);

	/** Whether there are any conversations to show in the dropdown. */
	const hasConversations = $derived(aiChatState.conversations.length > 0);
</script>

<div class="flex h-full flex-col">
	<!-- Conversation bar -->
	<div class="flex items-center gap-1 border-b px-2 py-1.5">
		{#if hasConversations}
			<Popover.Root bind:open={conversationPicker.open}>
				<Popover.Trigger bind:ref={conversationPicker.triggerRef}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							role="combobox"
							aria-expanded={conversationPicker.open}
							class="h-7 min-w-0 flex-1 justify-between gap-1 px-2 text-xs"
						>
							<span class="truncate">{activeTitle}</span>
							<ChevronDownIcon class="size-3 shrink-0 opacity-50" />
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content class="w-[280px] p-0" align="start">
					<Command.Root shouldFilter={false}>
						<Command.Input
							placeholder="Search conversations\u2026"
							class="h-9 text-sm"
							bind:value={conversationSearch}
						/>
						<Command.List class="max-h-[300px]">
							<Command.Empty>No conversations found.</Command.Empty>
							{#each filteredConversations as conv (conv.id)}
								<Command.Item
									value={conv.id}
									class="group flex-col items-start gap-0.5"
									onSelect={() => {
										aiChatState.switchConversation(conv.id);
										conversationSearch = '';
										conversationPicker.closeAndFocusTrigger();
									}}
								>
									<span class="flex w-full items-center justify-between gap-1.5 text-xs">
										<span class="flex min-w-0 items-center gap-1.5">
											<CheckIcon
												class={cn('mr-0.5 size-3 shrink-0', {
													'text-transparent': conv.id !== aiChatState.activeConversationId,
												})}
											/>
											<span class="min-w-0 truncate font-medium">{conv.title}</span>
											{#if aiChatState.isStreaming(conv.id)}
												<LoaderCircleIcon class="size-3 shrink-0 animate-spin text-muted-foreground" />
											{/if}
										</span>
										<span class="flex shrink-0 items-center gap-1">
											<span class="text-[10px] text-muted-foreground">{formatRelativeTime(conv.updatedAt)}</span>
											<button
												class="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
												onclick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													confirmationDialog.open({
														title: 'Delete conversation',
													description: `Delete "${conv.title}"? This will remove all messages in this conversation.`,
														confirm: { text: 'Delete', variant: 'destructive' },
														onConfirm: () => aiChatState.deleteConversation(conv.id),
													});
												}}
											>
												<TrashIcon class="size-3" />
											</button>
										</span>
									</span>
									{@const preview = aiChatState.getLastMessagePreview(conv.id)}
									{#if preview}
										<span class="w-full truncate pl-5 text-[10px] text-muted-foreground">{preview}</span>
									{/if}
								</Command.Item>
							{/each}
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
		{:else}
			<span class="flex-1 px-2 text-xs text-muted-foreground">No chats yet</span
			>
		{/if}

		<Button
			variant="ghost"
			size="icon"
			class="size-7 shrink-0"
			onclick={() => aiChatState.createConversation()}
		>
			<MessageSquarePlusIcon class="size-3.5" />
		</Button>
	</div>

	<!-- Messages area -->
	<div class="min-h-0 flex-1">
		{#if aiChatState.messages.length === 0}
			<Empty.Root class="py-12">
				<Empty.Media>
					<SparklesIcon class="size-8 text-muted-foreground" />
				</Empty.Media>
				<Empty.Title>AI Chat</Empty.Title>
				<Empty.Description>
					{#if hasConversations}
						Send a message to continue the conversation
					{:else}
						Send a message to start chatting
					{/if}
				</Empty.Description>
			</Empty.Root>
		{:else}
			<Chat.List>
				{#each aiChatState.messages as message (message.id)}
					<Chat.Bubble variant={message.role === 'user' ? 'sent' : 'received'}>
						<Chat.BubbleMessage>
							{getTextContent(message.parts)}
						</Chat.BubbleMessage>
					</Chat.Bubble>
				{/each}
				{#if showLoadingDots}
					<Chat.Bubble variant="received">
						<Chat.BubbleMessage typing />
					</Chat.Bubble>
				{/if}
				{#if showRegenerate}
					<div class="flex justify-start px-2 py-1">
						<Button
							variant="ghost"
							size="sm"
							class="h-7 gap-1 text-xs text-muted-foreground"
							onclick={() => aiChatState.reload()}
						>
							<RotateCcwIcon class="size-3" />
							Regenerate
						</Button>
					</div>
				{/if}
			</Chat.List>
		{/if}
	</div>

	<!-- Error banner -->
	{#if aiChatState.error && aiChatState.error.message !== dismissedError}
		<div
			role="alert"
			class="flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
		>
			<span class="min-w-0 flex-1">{aiChatState.error.message}</span>
			<div class="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
					onclick={() => {
						dismissedError = null;
						aiChatState.reload();
					}}
				>
					<RotateCcwIcon class="size-3" />
					Retry
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="size-6 text-destructive hover:text-destructive"
					onclick={() => {
						dismissedError = aiChatState.error?.message ?? null;
					}}
				>
					<XIcon class="size-3" />
				</Button>
			</div>
		</div>
	{/if}

	<!-- Controls area -->
	<div class="flex flex-col gap-1.5 border-t bg-background px-2 py-1.5">
		<!-- Provider + Model selects -->
		<div class="flex gap-2">
			<Select.Root
				type="single"
				value={aiChatState.provider}
				onValueChange={(v) => {
					if (v) aiChatState.provider = v;
				}}
			>
				<Select.Trigger size="sm" class="flex-1">
					{aiChatState.provider}
				</Select.Trigger>
				<Select.Content>
					{#each aiChatState.availableProviders as p (p)}
						<Select.Item value={p} label={p} />
					{/each}
				</Select.Content>
			</Select.Root>

			<ModelCombobox class="flex-1" />
		</div>

		<!-- Input + send/stop button -->
		<form
			class="flex items-end gap-1.5"
			aria-label="Chat message"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<Textarea
				class="min-h-0 max-h-32 flex-1 resize-none overflow-y-auto"
				rows={1}
				placeholder="Type a message…"
				bind:value={inputValue}
				onkeydown={(e: KeyboardEvent) => {
					if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
						e.preventDefault();
						send();
					}
				}}
			/>
			{#if aiChatState.isLoading}
				<Button
					variant="outline"
					size="icon-lg"
					type="button"
					onclick={() => aiChatState.stop()}
				>
					<SquareIcon />
				</Button>
			{:else}
				<Button
					variant="default"
					size="icon-lg"
					type="submit"
					disabled={!inputValue.trim()}
				>
					<SendIcon />
				</Button>
			{/if}
		</form>
	</div>
</div>

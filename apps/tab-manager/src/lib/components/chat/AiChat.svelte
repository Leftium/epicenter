<script lang="ts">
	import { aiChatState } from '$lib/state/chat-state.svelte';
	import ChatErrorBanner from './ChatErrorBanner.svelte';
	import ChatInput from './ChatInput.svelte';
	import ConversationPicker from './ConversationPicker.svelte';
	import MessageList from './MessageList.svelte';

	const active = $derived(aiChatState.active);
</script>

<div class="flex h-full flex-col">
	<ConversationPicker
		conversations={aiChatState.conversations}
		activeId={aiChatState.activeConversationId}
		onSwitch={(id) => aiChatState.switchTo(id)}
		onCreate={() => aiChatState.createConversation()}
	/>

	<div class="min-h-0 flex-1">
		<MessageList
			messages={active?.messages ?? []}
			status={active?.status ?? 'ready'}
			onReload={() => active?.reload()}
		/>
	</div>

	{#if active}
		<ChatErrorBanner
			error={active.error}
			dismissedError={active.dismissedError}
			onRetry={() => {
				active.dismissedError = null;
				active.reload();
			}}
			onDismiss={() => {
				active.dismissedError = active.error?.message ?? null;
			}}
		/>
	{/if}

	<ChatInput {active} />
</div>

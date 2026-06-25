<script lang="ts">
	import {
		AgentChatThread,
		ConversationSwitcher,
	} from '@epicenter/app-shell/agent-chat';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';

	const opensidian = requireOpensidian();
	const chat = opensidian.state.chat;
	const active = $derived(chat.active);
</script>

<div class="flex h-full flex-col">
	<ConversationSwitcher
		conversations={chat.conversations}
		activeConversationId={chat.activeConversationId}
		onSwitch={(id) => chat.switchTo(id)}
		onCreate={() => chat.createConversation()}
	/>

	{#if active}
		<AgentChatThread
			conversation={active}
			connections={inferenceConnections}
			onSignIn={() => {
				// TODO: open auth popover or navigate to sign-in
			}}
			onUpgrade={() => {
				// TODO: open billing / upgrade flow
			}}
		/>
	{/if}
</div>

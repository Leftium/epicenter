<script lang="ts">
	import {
		AgentChatThread,
		ConversationSwitcher,
	} from '@epicenter/app-shell/agent-chat';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import CrossDeviceStatus from './CrossDeviceStatus.svelte';

	const opensidian = requireOpensidian();
	const chat = opensidian.state.chat;
	const active = $derived(chat.active);
</script>

<div class="flex h-full flex-col">
	<div class="flex items-center gap-1 pr-1">
		<div class="min-w-0 flex-1">
			<ConversationSwitcher
				conversations={chat.conversations}
				activeConversationId={chat.activeConversationId}
				onSwitch={(id) => chat.switchTo(id)}
				onCreate={() => chat.createConversation()}
			/>
		</div>
		<CrossDeviceStatus />
	</div>

	{#if active}
		<AgentChatThread conversation={active} connections={inferenceConnections} />
	{/if}
</div>

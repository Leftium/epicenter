<script lang="ts">
	import { AgentChatThread } from '@epicenter/app-shell/agent-chat';
	import { Button } from '@epicenter/ui/button';
	import SquarePenIcon from '@lucide/svelte/icons/square-pen';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import MessageParts from './MessageParts.svelte';

	const opensidian = requireOpensidian();
	const active = $derived(opensidian.state.chat.active);
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between border-b px-3 py-2">
		<h2 class="text-sm font-medium">AI Chat</h2>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => opensidian.state.chat.createConversation()}
		>
			<SquarePenIcon class="size-3.5" />
			New Chat
		</Button>
	</div>

	{#if active}
		<AgentChatThread
			conversation={active}
			connections={inferenceConnections}
			defaultModel={DEFAULT_MODEL}
			onSignIn={() => {
				// TODO: open auth popover or navigate to sign-in
			}}
			onUpgrade={() => {
				// TODO: open billing / upgrade flow
			}}
		>
			{#snippet message(msg)}
				<MessageParts
					parts={msg.parts}
					pendingApprovalCallId={active?.pendingApprovalCallId ?? null}
					onApproveToolCall={() => active?.approveToolCall()}
					onDenyToolCall={() => active?.denyToolCall()}
				/>
			{/snippet}
		</AgentChatThread>
	{/if}
</div>

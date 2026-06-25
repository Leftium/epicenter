<script lang="ts">
	import { AgentChatThread } from '@epicenter/app-shell/agent-chat';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireTabManager } from '$lib/session.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ConversationPicker from './ConversationPicker.svelte';
	import MessageParts from './MessageParts.svelte';

	const tabManager = requireTabManager();
	const aiChat = $derived(tabManager.state.aiChat);
	const active = $derived(aiChat.active);

	/** Trust the pending tool from now on, then approve it. The trust set lives in
	 * tab-manager, so "Always Allow" is composed here from the handle's exposed
	 * pending-tool name rather than baked into the shared chat state. */
	function alwaysAllowPendingToolCall() {
		const toolName = active?.pendingApprovalToolName;
		if (toolName) tabManager.state.toolTrust.allow(toolName);
		active?.approveToolCall();
	}
</script>

<div class="flex h-full flex-col">
	<ConversationPicker
		conversations={aiChat.conversations}
		activeId={aiChat.activeConversationId}
		onSwitch={(id) => aiChat.switchTo(id)}
		onCreate={() => aiChat.createConversation()}
	/>

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
					onAlwaysAllowToolCall={alwaysAllowPendingToolCall}
				/>
			{/snippet}
		</AgentChatThread>
	{/if}
</div>

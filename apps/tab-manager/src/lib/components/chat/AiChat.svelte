<script lang="ts">
	import {
		AgentChatThread,
		ConversationSwitcher,
	} from '@epicenter/app-shell/agent-chat';
	import { requireTabManager } from '$lib/session.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';

	const tabManager = requireTabManager();
	const aiChat = $derived(tabManager.state.aiChat);
	const active = $derived(aiChat.active);

	/** A tool call's human title from its declaring action, or undefined to let the
	 * shared renderer title-case the tool name. */
	const actionTitles = $derived(
		tabManager.actions as Record<string, { title?: string }>,
	);

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
	<ConversationSwitcher
		conversations={aiChat.conversations}
		activeConversationId={aiChat.activeConversationId}
		onSwitch={(id) => aiChat.switchTo(id)}
		onCreate={() => aiChat.createConversation()}
	/>

	{#if active}
		<AgentChatThread
			conversation={active}
			connections={inferenceConnections}
			resolveToolTitle={(toolName) => actionTitles[toolName]?.title}
			onAlwaysAllow={alwaysAllowPendingToolCall}
			onSignIn={() => {
				// TODO: open auth popover or navigate to sign-in
			}}
			onUpgrade={() => {
				// TODO: open billing / upgrade flow
			}}
		/>
	{/if}
</div>

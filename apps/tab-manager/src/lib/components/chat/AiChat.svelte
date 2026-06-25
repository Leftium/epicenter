<script lang="ts">
	import {
		ChatErrorBanner,
		ChatInput,
	} from '@epicenter/app-shell/agent-chat';
	import {
		CrossDeviceModelGap,
		InferencePicker,
	} from '@epicenter/app-shell/inference-picker';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireTabManager } from '$lib/session.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ConversationPicker from './ConversationPicker.svelte';
	import MessageList from './MessageList.svelte';

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

	<div class="min-h-0 flex-1">
		<MessageList
			messages={active?.messages ?? []}
			streaming={active?.streaming ?? null}
			status={active?.status ?? 'ready'}
			onReload={() => active?.reload()}
			pendingApprovalCallId={active?.pendingApprovalCallId ?? null}
			onApproveToolCall={() => active?.approveToolCall()}
			onDenyToolCall={() => active?.denyToolCall()}
			onAlwaysAllowToolCall={alwaysAllowPendingToolCall}
		/>
	</div>

	{#if active}
		<ChatErrorBanner
			conversation={active}
			onSignIn={() => {
				// TODO: open auth popover or navigate to sign-in
			}}
			onUpgrade={() => {
				// TODO: open billing / upgrade flow
			}}
		/>

		<CrossDeviceModelGap
			model={active.model}
			connections={inferenceConnections}
			onUseDefault={() => (active.model = DEFAULT_MODEL)}
		/>

		<!-- The shared model-first picker (ADR-0059): the conversation's model bound
		     to this device's connection registry. Locked mid-turn so a transcript
		     never spans backends. -->
		<div class="flex items-center gap-2 bg-background px-2 pt-1.5">
			<InferencePicker
				model={active.model}
				onSelectModel={(model) => (active.model = model)}
				connections={inferenceConnections}
				disabled={active.isLoading}
			/>
		</div>

		<ChatInput
			bind:value={active.inputValue}
			canSend={active.canSend}
			isGenerating={active.isLoading}
			onSend={(content) => active.sendMessage(content)}
			onStop={() => active.stop()}
		/>
	{/if}
</div>

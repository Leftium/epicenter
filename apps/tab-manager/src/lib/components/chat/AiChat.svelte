<script lang="ts">
	import { ChatInput } from '@epicenter/app-shell/agent-chat';
	import {
		CrossDeviceModelGap,
		InferencePicker,
	} from '@epicenter/app-shell/inference-picker';
	import { Button } from '@epicenter/ui/button';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireTabManager } from '$lib/session.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ChatErrorBanner from './ChatErrorBanner.svelte';
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

	<!-- Error states: auth + credits are persistent, others go to ChatErrorBanner -->
	{#if active?.isUnauthorized}
		<div
			role="alert"
			class="flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
		>
			<span class="min-w-0 flex-1">Sign in to use AI Chat</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
				onclick={() => {
					// TODO: open auth popover or navigate to sign-in
				}}
			>
				<LogInIcon class="size-3" />
				Sign In
			</Button>
		</div>
	{:else if active?.isCreditsExhausted}
		<div
			role="alert"
			class="flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
		>
			<span class="min-w-0 flex-1">You're out of credits</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
				onclick={() => {
					// TODO: open billing / upgrade flow
				}}
			>
				Upgrade
			</Button>
		</div>
	{:else if active}
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

	{#if active}
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
			canSend={inferenceConnections.canServe(active.model) &&
				!active.isLoading &&
				active.inputValue.trim().length > 0}
			isGenerating={active.isLoading}
			onSend={(content) => active.sendMessage(content)}
			onStop={() => active.stop()}
		/>
	{/if}
</div>

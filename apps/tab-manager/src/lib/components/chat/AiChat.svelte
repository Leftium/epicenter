<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireTabManager } from '$lib/session.svelte';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ChatErrorBanner from './ChatErrorBanner.svelte';
	import ChatInput from './ChatInput.svelte';
	import ConversationPicker from './ConversationPicker.svelte';
	import MessageList from './MessageList.svelte';

	const tabManager = requireTabManager();
	const active = $derived(tabManager.state.aiChat.active);

	// The conversation's model (ADR-0055) resolves against this device's
	// connections. When no connection here serves it (a custom model set on another
	// device), the banner shows and sending is blocked; the synced model column is
	// never rewritten on detection, only by an explicit pick (ADR-0059).
	const isModelAvailable = $derived(
		!active || inferenceConnections.canServe(active.model),
	);

	/** Fall back to tab-manager's always-available hosted default for this chat. */
	function useHostedDefault() {
		if (active) active.model = DEFAULT_MODEL;
	}
</script>

<div class="flex h-full flex-col">
	<ConversationPicker
		conversations={tabManager.state.aiChat.conversations}
		activeId={tabManager.state.aiChat.activeConversationId}
		onSwitch={(id) => tabManager.state.aiChat.switchTo(id)}
		onCreate={() => tabManager.state.aiChat.createConversation()}
	/>

	<div class="min-h-0 flex-1">
		<MessageList
			messages={tabManager.state.aiChat.active?.messages ?? []}
			streaming={tabManager.state.aiChat.active?.streaming ?? null}
			status={tabManager.state.aiChat.active?.status ?? 'ready'}
			onReload={() => tabManager.state.aiChat.active?.reload()}
			pendingApprovalCallId={tabManager.state.aiChat.active
				?.pendingApprovalCallId ?? null}
			onApproveToolCall={() =>
				tabManager.state.aiChat.active?.approveToolCall()}
			onDenyToolCall={() => tabManager.state.aiChat.active?.denyToolCall()}
			onAlwaysAllowToolCall={() =>
				tabManager.state.aiChat.active?.alwaysAllowToolCall()}
		/>
	</div>

	<!-- Error states: auth + credits are persistent, others go to ChatErrorBanner -->
	{#if tabManager.state.aiChat.active?.isUnauthorized}
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
	{:else if tabManager.state.aiChat.active?.isCreditsExhausted}
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
	{:else if tabManager.state.aiChat.active}
		<ChatErrorBanner
			error={tabManager.state.aiChat.active.error}
			dismissedError={tabManager.state.aiChat.active.dismissedError}
			onRetry={() => {
				if (!tabManager.state.aiChat.active) return;
				tabManager.state.aiChat.active.dismissedError = null;
				tabManager.state.aiChat.active.reload();
			}}
			onDismiss={() => {
				if (!tabManager.state.aiChat.active) return;
				tabManager.state.aiChat.active.dismissedError =
					tabManager.state.aiChat.active.error?.message ?? null;
			}}
		/>
	{/if}

	<!-- Cross-device model gap: this conversation's model is not served by any
	     connection on this device. Offer the hosted default; never rewrite the
	     synced model column on detection (ADR-0059). -->
	{#if active && !isModelAvailable}
		<div
			class="flex items-center justify-between gap-2 border-t bg-muted/50 px-3 py-2 text-xs"
		>
			<span class="min-w-0 flex-1">
				This conversation uses
				<span class="font-mono">{active.model}</span>, set up on another device
				and not reachable here.
			</span>
			<Button
				variant="outline"
				size="sm"
				class="h-6 px-2 text-xs"
				onclick={useHostedDefault}
			>
				Use the default
			</Button>
		</div>
	{/if}

	<ChatInput active={tabManager.state.aiChat.active} />
</div>

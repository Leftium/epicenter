<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import { requireApp } from '$lib/session.svelte';
	import ChatErrorBanner from './ChatErrorBanner.svelte';
	import ChatInput from './ChatInput.svelte';
	import ConversationPicker from './ConversationPicker.svelte';
	import MessageList from './MessageList.svelte';

	const app = requireApp();
</script>

<div class="flex h-full flex-col">
	<ConversationPicker
		conversations={app.state.aiChat.conversations}
		activeId={app.state.aiChat.activeConversationId}
		onSwitch={(id) => app.state.aiChat.switchTo(id)}
		onCreate={() => app.state.aiChat.createConversation()}
	/>

	<div class="min-h-0 flex-1">
		<MessageList
			messages={app.state.aiChat.active?.messages ?? []}
			status={app.state.aiChat.active?.status ?? 'ready'}
			onReload={() => app.state.aiChat.active?.reload()}
			onApproveToolCall={(id) =>
				app.state.aiChat.active?.approveToolCall(id)}
			onDenyToolCall={(id) =>
				app.state.aiChat.active?.denyToolCall(id)}
		/>
	</div>

	<!-- Error states: auth + credits are persistent, others go to ChatErrorBanner -->
	{#if app.state.aiChat.active?.isUnauthorized}
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
	{:else if app.state.aiChat.active?.isCreditsExhausted}
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
	{:else if app.state.aiChat.active}
		<ChatErrorBanner
			error={app.state.aiChat.active.error}
			dismissedError={app.state.aiChat.active.dismissedError}
			onRetry={() => {
				if (!app.state.aiChat.active) return;
				app.state.aiChat.active.dismissedError = null;
				app.state.aiChat.active.reload();
			}}
			onDismiss={() => {
				if (!app.state.aiChat.active) return;
				app.state.aiChat.active.dismissedError =
					app.state.aiChat.active.error?.message ?? null;
			}}
		/>
	{/if}

	<ChatInput active={app.state.aiChat.active} />
</div>

<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SquarePenIcon from '@lucide/svelte/icons/square-pen';
	import XIcon from '@lucide/svelte/icons/x';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import ChatInput from './ChatInput.svelte';
	import MessageList from './MessageList.svelte';

	const opensidian = requireOpensidian();
	const active = $derived(opensidian.state.chat.active);

	/** Tracks which error message was dismissed so it doesn't reappear. */
	let dismissedError = $state<string | null>(null);

	const errorVisible = $derived(
		active?.error && active.error.message !== dismissedError,
	);

	// The conversation's model (ADR-0055) resolves against this device's
	// connections. When no connection here serves it (a custom model set on another
	// device), the banner shows and sending is blocked; the synced model column is
	// never rewritten on detection, only by an explicit pick (ADR-0058).
	const isModelAvailable = $derived(
		!active || inferenceConnections.resolve(active.model) !== null,
	);

	/** Fall back to opensidian's always-available hosted default for this chat. */
	function useHostedDefault() {
		if (active) active.model = DEFAULT_MODEL;
	}
</script>

<div class="flex h-full flex-col">
	<!-- Header -->
	<div class="flex items-center justify-between border-b px-3 py-2">
		<h2 class="text-sm font-medium">AI Chat</h2>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => {
				opensidian.state.chat.newConversation();
				dismissedError = null;
			}}
		>
			<SquarePenIcon class="size-3.5" />
			New Chat
		</Button>
	</div>

	<!-- Message list -->
	<div class="min-h-0 flex-1">
		<MessageList
			messages={active?.messages ?? []}
			streaming={active?.streaming ?? null}
			status={active?.status ?? 'ready'}
			onReload={() => active?.reload()}
			pendingApprovalCallId={active?.pendingApprovalCallId ?? null}
			onApproveToolCall={() => active?.approveToolCall()}
			onDenyToolCall={() => active?.denyToolCall()}
		/>
	</div>

	<!-- Error states: auth + credits are persistent (no dismiss), others are dismissable -->
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
	{:else if errorVisible}
		<!-- Dismissable errors: model restriction, generic, etc. -->
		<div
			role="alert"
			class="flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
		>
			<span class="min-w-0 flex-1">{active?.error?.message}</span>
			<div class="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
					onclick={() => {
						dismissedError = null;
						active?.reload();
					}}
				>
					<RotateCcwIcon class="size-3" />
					Retry
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					class="text-destructive hover:text-destructive"
					onclick={() => {
						dismissedError = active?.error?.message ?? null;
					}}
				>
					<XIcon class="size-3" />
				</Button>
			</div>
		</div>
	{/if}

	<!-- Cross-device model gap: this conversation's model is not served by any
	     connection on this device. Offer the hosted default; never rewrite the
	     synced model column on detection (ADR-0058). -->
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

	<!-- Chat input -->
	<ChatInput disabled={!isModelAvailable} />
</div>

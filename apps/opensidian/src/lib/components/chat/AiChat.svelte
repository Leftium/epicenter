<script lang="ts">
	import { ChatInput } from '@epicenter/app-shell/agent-chat';
	import {
		CrossDeviceModelGap,
		InferencePicker,
	} from '@epicenter/app-shell/inference-picker';
	import { Button } from '@epicenter/ui/button';
	import LogInIcon from '@lucide/svelte/icons/log-in';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SquarePenIcon from '@lucide/svelte/icons/square-pen';
	import XIcon from '@lucide/svelte/icons/x';
	import { DEFAULT_MODEL } from '$lib/chat/models';
	import { requireOpensidian } from '$lib/session';
	import { inferenceConnections } from '$lib/state/inference-connections.svelte';
	import MessageList from './MessageList.svelte';

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
	{:else if active?.visibleError}
		<!-- Dismissable errors: model restriction, generic, etc. -->
		<div
			role="alert"
			class="flex items-center justify-between gap-2 border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
		>
			<span class="min-w-0 flex-1">{active.visibleError.message}</span>
			<div class="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="sm"
					class="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
					onclick={() => active?.reload()}
				>
					<RotateCcwIcon class="size-3" />
					Retry
				</Button>
				<Button
					variant="ghost"
					size="icon-xs"
					class="text-destructive hover:text-destructive"
					onclick={() => active?.dismissError()}
				>
					<XIcon class="size-3" />
				</Button>
			</div>
		</div>
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
			canSend={active.canSend}
			isGenerating={active.isLoading}
			onSend={(content) => active.sendMessage(content)}
			onStop={() => active.stop()}
		/>
	{/if}
</div>

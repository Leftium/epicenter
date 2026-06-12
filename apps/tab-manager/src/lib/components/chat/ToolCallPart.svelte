<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import WrenchIcon from '@lucide/svelte/icons/wrench';
	import type { ToolCallPart as TanStackToolCallPart } from '@tanstack/ai-client';
	import { requireTabManager } from '$lib/session.svelte';
	import CollapsibleSection from '../CollapsibleSection.svelte';

	const tabManager = requireTabManager();
	let {
		part,
		onApproveToolCall,
		onDenyToolCall,
	}: {
		part: TanStackToolCallPart;
		onApproveToolCall: (approvalId: string) => void;
		onDenyToolCall: (approvalId: string) => void;
	} = $props();

	const isRunning = $derived(part.output == null);
	const isFailed = $derived(
		typeof part.output === 'object' &&
			part.output !== null &&
			'error' in part.output,
	);
	const displayName = $derived(
		tabManager.sessionAiTools.definitions.find((d) => d.name === part.name)
			?.title ??
			part.name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()),
	);
	const isApprovalRequested = $derived(part.state === 'approval-requested');
	const isAutoApproved = $derived(
		isApprovalRequested &&
			tabManager.state.toolTrust.shouldAutoApprove(part.name),
	);
	const badgeVariant = $derived.by(() => {
		if (isApprovalRequested) return 'secondary';
		if (isFailed) return 'status.failed';
		if (isRunning) return 'status.running';
		return 'status.completed';
	});

	$effect(() => {
		if (isAutoApproved && part.approval?.id) {
			onApproveToolCall(part.approval.id);
		}
	});

	function handleAllow() {
		if (!part.approval?.id) return;
		onApproveToolCall(part.approval.id);
	}

	function handleAlwaysAllow() {
		if (!part.approval?.id) return;
		tabManager.state.toolTrust.set(part.name, 'always');
		onApproveToolCall(part.approval.id);
	}

	function handleDeny() {
		if (!part.approval?.id) return;
		onDenyToolCall(part.approval.id);
	}
</script>

{#snippet codeBlock(text: string)}
	<pre
		class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px]"
	>{text}</pre>
{/snippet}

<div class="flex flex-col gap-1 py-1">
	<div class="flex items-center gap-1.5">
		{#if isAutoApproved}
			<ShieldCheckIcon class="size-3 text-green-500" />
		{:else if isApprovalRequested}
			<ShieldAlertIcon class="size-3 text-amber-500" />
		{:else if isRunning}
			<Spinner class="size-3 text-blue-500" />
		{:else}
			<WrenchIcon class="size-3 text-muted-foreground" />
		{/if}
		<Badge variant={badgeVariant}>
			{displayName}{isRunning && !isApprovalRequested ? '…': ''}
		</Badge>
	</div>

	{#if isAutoApproved}
		<div class="pl-[1.125rem] text-xs text-muted-foreground">Auto-approved</div>
	{:else if isApprovalRequested}
		<div class="flex items-center gap-1.5 pl-[1.125rem]">
			<Button variant="outline" size="sm" onclick={handleAllow}> Allow </Button>
			<Button variant="outline" size="sm" onclick={handleAlwaysAllow}>
				Always Allow
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="text-muted-foreground"
				onclick={handleDeny}
			>
				Deny
			</Button>
		</div>
	{/if}

	<CollapsibleSection label="Details" contentClass="bg-muted/50">
		{#if part.arguments}
			<div class="mb-1">
				<span class="font-medium text-muted-foreground">Arguments:</span>
				{@render codeBlock(part.arguments)}
			</div>
		{/if}
		{#if part.output != null}
			<div>
				<span class="font-medium text-muted-foreground">Result:</span>
				{@render codeBlock(
					typeof part.output === 'string'
						? part.output
						: JSON.stringify(part.output, null, 2),
				)}
			</div>
		{/if}
	</CollapsibleSection>
</div>

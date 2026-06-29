<script lang="ts">
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import { requireOpensidian } from '$lib/session';

	const opensidian = requireOpensidian();
	const crossDevice = opensidian.state.crossDevice;

	// Devices are addressed by nodeId; show a short prefix until presence carries a
	// human label (deferred, see the cross-device state module).
	const short = (nodeId: string) => nodeId.slice(0, 12);
	const isActive = (nodeId: string) => crossDevice.active?.nodeId === nodeId;
</script>

<Popover.Root>
	<Popover.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}>
		<MonitorSmartphoneIcon class="size-3.5" />
	</Popover.Trigger>
	<Popover.Content class="w-72 space-y-2" align="end" side="bottom">
		<div class="space-y-0.5">
			<p class="text-sm font-medium">Cross-device tools</p>
			<p class="text-xs text-muted-foreground">
				Reach a tool running on another of your signed-in devices over the relay
				floor.
			</p>
		</div>

		{#if crossDevice.peers.length === 0}
			<Empty.Root class="py-6">
				<Empty.Title class="text-sm">No other devices online</Empty.Title>
				<Empty.Description class="text-xs">
					Start a daemon with a relay-exposed route to reach its tools here.
				</Empty.Description>
			</Empty.Root>
		{:else}
			<ul class="space-y-1">
				{#each crossDevice.peers as peer (peer.nodeId)}
					{@const active = isActive(peer.nodeId)}
					<li class="flex items-center justify-between gap-2">
						<span class="truncate font-mono text-xs" title={peer.nodeId}>
							{short(peer.nodeId)}
						</span>
						{#if active && crossDevice.active?.status === 'connecting'}
							<Spinner class="size-3.5" />
						{:else if active && crossDevice.active?.status === 'ready'}
							<Button
								variant="secondary"
								size="sm"
								onclick={() => void crossDevice.disconnect()}
							>
								Disconnect
							</Button>
						{:else}
							<Button
								variant="ghost"
								size="sm"
								onclick={() => void crossDevice.connect(peer.nodeId)}
							>
								Connect
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if crossDevice.active?.status === 'error'}
			<p class="text-xs text-destructive">
				Could not reach {short(crossDevice.active.nodeId)}: {crossDevice.active
					.error}
			</p>
		{/if}
	</Popover.Content>
</Popover.Root>

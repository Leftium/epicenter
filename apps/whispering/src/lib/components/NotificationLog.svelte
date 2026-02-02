<script module lang="ts">
	const notificationLog = (() => {
		let isOpen = $state(false);
		let logs = $state<UnifiedNotificationOptions[]>([]);
		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value: boolean) {
				isOpen = value;
			},
			get logs() {
				return logs;
			},
			addLog: (log: UnifiedNotificationOptions) => {
				logs.push(log);
			},
			clearLogs: () => {
				logs = [];
			},
		};
	})();

	export { notificationLog };
</script>

<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Modal from '@epicenter/ui/modal';
	import * as Empty from '@epicenter/ui/empty';
	import type { UnifiedNotificationOptions } from '$lib/services/isomorphic/notifications/types';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import AlertCircle from '@lucide/svelte/icons/alert-circle';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import BellIcon from '@lucide/svelte/icons/bell';
	import CheckCircle2 from '@lucide/svelte/icons/check-circle-2';
	import Info from '@lucide/svelte/icons/info';
	import { Spinner } from '@epicenter/ui/spinner';
	import { mode } from 'mode-watcher';
</script>

<Modal.Root bind:open={notificationLog.isOpen}>
	<Modal.Content class="max-w-md">
		<Modal.Header>
			<Modal.Title>Notification History</Modal.Title>
			<Modal.Description>View past notifications</Modal.Description>
		</Modal.Header>

		<ScrollArea
			class="h-[60vh] overflow-y-auto rounded-md border bg-background p-4"
			data-sonner-toaster
			data-theme={mode.current}
			data-rich-colors="true"
		>
			{#each notificationLog.logs as log}
				<Alert.Root
					class="mb-2 last:mb-0"
					data-sonner-toast
					data-type={log.variant}
					data-styled="true"
					data-mounted="true"
				>
					<div class="flex items-center gap-3">
						{#if log.variant === 'error'}
							<div data-icon class="text-destructive">
								<AlertCircle class="size-4" />
							</div>
						{:else if log.variant === 'warning'}
							<div data-icon class="text-warning">
								<AlertTriangle class="size-4" />
							</div>
						{:else if log.variant === 'success'}
							<div data-icon class="text-success">
								<CheckCircle2 class="size-4" />
							</div>
						{:else if log.variant === 'info'}
							<div data-icon class="text-info"><Info class="size-4" /></div>
						{:else if log.variant === 'loading'}
							<div data-icon class="text-muted-foreground">
								<Spinner />
							</div>
						{/if}
						<div class="flex-1">
							<Alert.Title
								class="text-sm font-medium leading-none tracking-tight"
							>
								{log.title}
							</Alert.Title>
							<Alert.Description class="mt-1 text-sm text-muted-foreground">
								{log.description}
							</Alert.Description>
						</div>
					</div>
				</Alert.Root>
			{/each}

			{#if notificationLog.logs.length === 0}
				<Empty.Root class="h-32">
					<Empty.Header>
						<Empty.Media variant="icon">
							<BellIcon />
						</Empty.Media>
						<Empty.Title>No notifications yet</Empty.Title>
						<Empty.Description>
							Notifications will appear here as they occur.
						</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
		</ScrollArea>
	</Modal.Content>
</Modal.Root>

<style>
	:global([data-slot='dialog-content'] [data-sonner-toast]) {
		position: relative;
	}
</style>

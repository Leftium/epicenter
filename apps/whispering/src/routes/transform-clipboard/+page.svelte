<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { Textarea } from '@epicenter/ui/textarea';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import { createQuery } from '@tanstack/svelte-query';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
	import { onDestroy, onMount } from 'svelte';
	import { queryOptions } from 'wellcrafted/query';
	import TransformationPickerBody from '$lib/components/TransformationPickerBody.svelte';
	import { deliverTransformationResult } from '$lib/operations/delivery';
	import { report } from '$lib/report';
	import { sound } from '$lib/operations/sound';
	import { tauri } from '#platform/tauri';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import * as transformClipboardWindow from './transformClipboardWindow.tauri';

	const combobox = useCombobox();

	const clipboardQuery = createQuery(() =>
		queryOptions({
			queryKey: ['text', 'readFromClipboard'],
			queryFn: () => services.text.readFromClipboard(),
			refetchInterval: 1000,
		}),
	);

	const clipboardText = $derived(clipboardQuery.data ?? '');

	let unlistenOpenCombobox: UnlistenFn | null = null;

	// Listen for event to open combobox
	onMount(async () => {
		unlistenOpenCombobox = await listen(
			'transform-clipboard-open-combobox',
			() => {
				// Try to focus the window
				const currentWindow = WebviewWindow.getCurrent();
				currentWindow.setFocus().catch(() => {
					// setFocus often fails on macOS, ignore the error
				});

				// Open the combobox
				combobox.open = true;
			},
		);
	});

	onDestroy(() => {
		unlistenOpenCombobox?.();
	});

	// Auto-open popover when clipboard has text
	$effect(() => {
		if (clipboardQuery.isSuccess && clipboardText.trim()) {
			combobox.open = true;
		}
	});

	$effect(() => {
		if (!tauri) return;

		if (clipboardQuery.error) {
			report.error({
				title: 'Failed to read clipboard',
				cause: clipboardQuery.error,
			});
			void transformClipboardWindow.hide();
		}

		if (clipboardQuery.isSuccess && !clipboardQuery.data?.trim()) {
			report.info({
				title: 'Empty clipboard',
				description: 'Please copy some text before running a transformation.',
			});
			void transformClipboardWindow.hide();
		}
	});
</script>

<div class="flex h-screen flex-col p-6 gap-4">
	<div class="space-y-2">
		<h2 class="text-2xl font-semibold">Transform Clipboard</h2>
		<p class="text-sm text-muted-foreground">
			Select a transformation to apply to your clipboard text
		</p>
	</div>

	{#if clipboardQuery.isPending}
		<div class="flex min-h-32 items-center justify-center">
			<p class="text-sm text-muted-foreground">Reading clipboard...</p>
		</div>
	{:else}
		<Textarea
			value={clipboardText}
			readonly
			class="min-h-32 resize-none font-mono text-sm"
		/>
	{/if}

	<Popover.Root bind:open={combobox.open}>
		<Popover.Trigger bind:ref={combobox.triggerRef}>
			{#snippet child({ props })}
				<Button
					{...props}
					role="combobox"
					aria-expanded={combobox.open}
					variant="outline"
					class="w-full justify-start gap-2"
				>
					<LayersIcon class="size-4" />
					Select Transformation
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content class="w-[var(--bits-popover-anchor-width)] p-0">
			<TransformationPickerBody
				onSelect={async (transformation) => {
					if (!clipboardText) return;

					combobox.closeAndFocusTrigger();

					const loading = report.loading({
						title: '🔄 Running transformation...',
						description: 'Transforming your clipboard text...',
					});

					const { data: output, error: transformError } =
						await rpc.transformer.transformInput({
							input: clipboardText,
							transformation,
						});

					if (transformError) {
						loading.reject({ cause: transformError });
						await transformClipboardWindow.hide();
						return;
					}

					sound.playSoundIfEnabled('transformationComplete');

					const notice = await deliverTransformationResult({
						text: output,
					});
					loading.resolve(notice);

					await transformClipboardWindow.hide();
				}}
				onSelectManageTransformations={async () => {
					combobox.closeAndFocusTrigger();
					await transformClipboardWindow.hide();
					await emit('navigate-main-window', { path: '/transformations' });
				}}
				placeholder="Search transformations..."
			/>
		</Popover.Content>
	</Popover.Root>
</div>

<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { goto } from '$app/navigation';
	import MacosAccessibilityGuide from '$lib/components/MacosAccessibilityGuide.svelte';
	import { permissions } from '$lib/state/permissions.svelte';

	// Read the live grant from the owner: it re-checks on window focus, so this
	// page flips to the granted state the moment the user returns from System
	// Settings, without a reload.
	const isGranted = $derived(permissions.accessibilityGranted);

	async function openSystemSettings() {
		const { error: commandError } =
			await permissions.openAccessibilitySettings();

		if (commandError) {
			console.error('Failed to open System Settings:', commandError);

			// Fallback: show detailed instructions.
			toast.info('Open System Settings Manually', {
				description:
					'Click Apple menu → System Settings → Privacy & Security → Accessibility',
				duration: 10000,
			});
			return;
		}

		toast.info('System Settings Opened', {
			description:
				'Navigate to Privacy & Security > Accessibility to grant permissions.',
			duration: 8000,
		});
	}
</script>

<svelte:head> <title>MacOS Accessibility</title> </svelte:head>

<main class="flex flex-1 items-center justify-center">
	<Card.Root class="w-full max-w-2xl">
		<Card.Header>
			<Card.Title class="text-xl">MacOS Accessibility</Card.Title>
			<Card.Description class="leading-7">
				Follow the steps below to re-enable Whispering in your macOS
				Accessibility settings. This is usually needed after an app update
				changes how macOS identifies Whispering.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<MacosAccessibilityGuide />
		</Card.Content>
		<Card.Footer>
			{#if !isGranted}
				<div class="flex gap-3 w-full">
					<Button
						variant="outline"
						onclick={() => goto('/')}
						class="flex-1 text-sm"
					>
						<ArrowLeft class="size-4" />
						Back to Home
					</Button>
					<Button
						onclick={() => permissions.requestAccessibility()}
						class="flex-1 text-sm"
					>
						<SettingsIcon class="size-4" />
						Request Permission
					</Button>
				</div>
			{:else}
				<div class="flex flex-col gap-3 w-full">
					<Badge variant="success">
						<CheckIcon class="size-4" />
						Accessibility permissions granted
					</Badge>
					<div class="flex gap-3">
						<Button
							variant="outline"
							onclick={() => goto('/')}
							class="flex-1 text-sm"
						>
							<ArrowLeft class="size-4" />
							Back to Home
						</Button>
						<Button
							onclick={() => openSystemSettings()}
							variant="outline"
							class="flex-1 text-sm"
						>
							<SettingsIcon class="size-4" />
							Open Settings
						</Button>
					</div>
				</div>
			{/if}
		</Card.Footer>
	</Card.Root>
</main>

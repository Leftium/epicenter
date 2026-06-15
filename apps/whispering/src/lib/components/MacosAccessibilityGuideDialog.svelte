<script module lang="ts">
	/**
	 * Global opener for the macOS Accessibility guide. Mirrors the
	 * `confirmationDialog` idiom: mount `<MacosAccessibilityGuideDialog />` once at
	 * the app root, then call `accessibilityGuide.open()` from anywhere (the
	 * home/setup notice, the shortcut recorder) to surface the remove/re-add
	 * walkthrough. The guide content is fixed, so the store carries no payload: it
	 * is open or closed and nothing else.
	 *
	 * The guide is user-opened, never auto-popped: the ambient "you still need
	 * this" signal is the declarative `MacosAccessibilityNotice`, which a modal
	 * must not duplicate by nagging.
	 */
	function createAccessibilityGuide() {
		let isOpen = $state(false);
		return {
			get isOpen() {
				return isOpen;
			},
			set isOpen(value) {
				isOpen = value;
			},
			open() {
				isOpen = true;
			},
			close() {
				isOpen = false;
			},
		};
	}

	export const accessibilityGuide = createAccessibilityGuide();
</script>

<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MacosAccessibilityGuide from '$lib/components/MacosAccessibilityGuide.svelte';
	import { permissions } from '$lib/state/permissions.svelte';

	// The owner re-checks on window focus, so the dialog flips to its granted
	// state the moment the user returns from System Settings, with no reload.
	const isGranted = $derived(permissions.accessibilityGranted);

	async function openSystemSettings() {
		const { error } = await permissions.openAccessibilitySettings();
		if (error) {
			// Deep-link failed: fall back to the manual path.
			toast.info('Open System Settings manually', {
				description:
					'Apple menu → System Settings → Privacy & Security → Accessibility',
				duration: 10000,
			});
			return;
		}
		toast.info('System Settings opened', {
			description:
				'Go to Privacy & Security > Accessibility to grant Whispering.',
			duration: 8000,
		});
	}
</script>

<Dialog.Root bind:open={accessibilityGuide.isOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Enable Accessibility</Dialog.Title>
			<Dialog.Description>
				macOS needs Accessibility to fire your global shortcut and paste where
				you're typing. After an app update it usually has to be removed and
				re-added.
			</Dialog.Description>
		</Dialog.Header>

		<MacosAccessibilityGuide />

		<Dialog.Footer>
			{#if isGranted}
				<Badge variant="success">
					<CheckIcon class="size-4" aria-hidden="true" />
					Accessibility granted
				</Badge>
				<Button variant="outline" onclick={() => accessibilityGuide.close()}>
					Done
				</Button>
			{:else}
				<Button variant="outline" onclick={openSystemSettings}>
					<SettingsIcon class="size-4" aria-hidden="true" />
					Open System Settings
				</Button>
				<Button onclick={() => permissions.requestAccessibility()}>
					Request permission
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

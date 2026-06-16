<script module lang="ts">
	import { toast } from '@epicenter/ui/sonner';
	import { permissions } from '$lib/state/permissions.svelte';

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

	/**
	 * Shared "send me to the Accessibility pane" action for both macOS
	 * accessibility surfaces: the home notice and this guide. It lives here beside
	 * `accessibilityGuide` because those are its only two callers and the toast
	 * copy must stay identical between them. The OS work belongs to the
	 * permissions owner (which cannot grant in place); this wrapper only adds the
	 * user-facing feedback: a follow-up hint on success, the manual menu path when
	 * the deep-link fails.
	 */
	export async function openSystemSettings() {
		const { error } = await permissions.openAccessibilitySettings();
		if (error) {
			toast.info('Open System Settings manually', {
				description:
					'Apple menu → System Settings → Privacy & Security → Accessibility',
				duration: 10000,
			});
			return;
		}
		toast.info('System Settings opened', {
			description: 'Turn on Whispering in Privacy & Security > Accessibility.',
			duration: 8000,
		});
	}
</script>

<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import MacosAccessibilityGuide from '$lib/components/MacosAccessibilityGuide.svelte';

	// The owner re-checks on window focus, so the dialog flips to its granted
	// state the moment the user returns from System Settings, with no reload.
	const isGranted = $derived(permissions.accessibilityGranted);
</script>

<Dialog.Root bind:open={accessibilityGuide.isOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Enable Accessibility</Dialog.Title>
			<Dialog.Description>
				macOS needs you to turn on Accessibility for Whispering before it can
				fire your global shortcut and paste where you're typing. After an app
				update it usually has to be removed and re-added.
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
				<Button onclick={openSystemSettings}>
					<SettingsIcon class="size-4" aria-hidden="true" />
					Open System Settings
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

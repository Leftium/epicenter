<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// One declarative view over the dictation capability Rust owns, in three
	// registers because the situations differ in kind, not just wording:
	//   - broken: a stale grant left the global tap dead. A real FAULT, so an
	//     outlined `role="alert"` banner with an amber glyph and a primary action.
	//   - untrusted (first grant): never granted. An optional UPGRADE, not a wall —
	//     dictation already works through the shortcut and clipboard. A faint muted
	//     banner with an outline action, sitting quietly until you grant.
	//   - unsupported (Wayland): a platform FACT, nothing to grant. A calm info
	//     banner pointing at the mic that still works; no action.
	// All three are one slim `Item` (icon · message · trailing action) at the same
	// size, so the padding is uniform by construction. None is dismissable: each
	// clears itself when the capability flips, and a quiet banner never needs
	// hiding. The detailed steps live in the guide dialog the action opens. The
	// branch order is load-bearing: `broken` is caught before the plain untrusted
	// case (`needsAccessibility` covers both).
	const isFirstGrant = $derived(
		dictationCapability.needsAccessibility && !dictationCapability.isStale,
	);
</script>

{#if dictationCapability.isStale}
	<Item.Root variant="outline" size="sm" class="w-full" role="alert">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Your global shortcut isn't firing</Item.Title>
			<Item.Description>
				Re-granting macOS Accessibility usually fixes it. Until then, transcripts
				go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if isFirstGrant}
	<Item.Root variant="muted" size="sm" class="w-full">
		<Item.Media>
			<WandSparklesIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Hold a key to talk, paste hands-free</Item.Title>
			<Item.Description>
				Optional upgrade — dictation already works through your shortcut and
				clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button
				size="sm"
				variant="outline"
				onclick={() => accessibilityGuide.open()}
			>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if dictationCapability.isUnsupported}
	<Item.Root variant="muted" size="sm" class="w-full">
		<Item.Media>
			<InfoIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Global shortcuts need an X11 session</Item.Title>
			<Item.Description>
				On Wayland, Whispering can't tap your keyboard globally. Click the mic to
				record instead.
			</Item.Description>
		</Item.Content>
	</Item.Root>
{/if}

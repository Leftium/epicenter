<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { outputWritesToCursor } from '$lib/operations/delivery';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import { recordings } from '$lib/state/recordings.svelte';

	// One declarative view over the dictation capability Rust owns, in registers
	// that differ in kind, not just wording. The untrusted case splits on whether
	// the user has actually configured cursor paste (`outputWritesToCursor`):
	//   - broken: a stale grant left the global tap dead. A real FAULT, so an amber
	//     glyph, a `role="alert"`, and a primary action.
	//   - untrusted + cursor paste configured: the paste the user asked for is
	//     silently not firing. A soft fault: amber glyph and a primary action, but
	//     no `role="alert"` (a steady recoverable state, not a change to announce).
	//   - untrusted + cursor paste off (first grant): never granted, and nothing
	//     configured needs it. An optional UPGRADE, not a wall, so the glyph is calm
	//     and the action is a quiet outline button.
	//   - unsupported (Wayland): a platform FACT, nothing to grant. An info glyph
	//     pointing at the mic that still works; no action.
	// All share one slim outlined `Item` (icon · message · trailing action) at the
	// same size, so backgrounds and padding stay uniform and only the glyph and the
	// action carry the register. None is dismissable: each clears itself when the
	// capability or the cursor toggle flips, and a quiet banner never needs hiding.
	// The detailed steps live in the guide dialog the action opens. The branch order
	// is load-bearing: `broken` is caught first, then the configured-paste fault
	// before the plain upgrade pitch.
	//
	// The optional pitch waits for the first transcript: it is a pitch, not a
	// problem, and "hold a key to talk" only means something once you have pressed
	// once and watched a transcript land. The configured-paste fault does NOT wait,
	// because turning cursor paste on is itself the signal that the pitch was
	// already accepted, so the gap is worth surfacing immediately. Both are derived
	// from state that already exists (recordings, settings), so neither costs a
	// dismissal flag. Breakage and the Wayland limit are never gated: those are
	// immediate.
	const hasDictatedOnce = $derived(
		recordings.sorted.some((r) => r.transcript.trim()),
	);
	// Cursor paste is configured but the grant isn't live, so the paste the user
	// asked for is silently falling back to the clipboard. Not a stale grant (that
	// is `isStale`), so it reads as a soft fault rather than the upgrade pitch.
	const cursorPasteNotFiring = $derived(
		dictationCapability.needsAccessibility &&
			!dictationCapability.isStale &&
			outputWritesToCursor(),
	);
	const isFirstGrant = $derived(
		dictationCapability.needsAccessibility &&
			!dictationCapability.isStale &&
			!outputWritesToCursor() &&
			hasDictatedOnce,
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
{:else if cursorPasteNotFiring}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Paste at cursor needs macOS Accessibility</Item.Title>
			<Item.Description>
				You've turned on paste at cursor, but it isn't granted yet. Until you
				grant it, transcripts go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if isFirstGrant}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<WandSparklesIcon class="size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Hold a key to talk, paste hands-free</Item.Title>
			<Item.Description>
				Your shortcut already copies transcripts to your clipboard.
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
	<Item.Root variant="outline" size="sm" class="w-full">
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

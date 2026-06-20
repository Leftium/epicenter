import type { WriteTextOutcome } from '$lib/tauri/bindings.gen';

/**
 * How far the text reached, relative to the user's configured output. Delivery is
 * a reduced-reach axis, not a pass/fail: the transcript is always saved to
 * history, so a reduced reach is a recoverable success, never a dictation failure
 * (ADR-0029).
 *
 * - `output`: landed where configured — pasted at the cursor, or copied to the
 *   clipboard / saved to history when that is the configured sink. The clean case.
 * - `clipboard`: a cursor write was requested but could not paste (no
 *   Accessibility grant, or the paste failed), so the transcript was left on the
 *   clipboard. Usable, but not where the user asked.
 *
 * There is no `history`-only reach: a cursor write that cannot paste always leaves
 * the transcript on the clipboard (see `write_text` in src-tauri and ADR-0030),
 * so the text is never stranded somewhere the user would not look.
 */
export type DeliveryReach = 'output' | 'clipboard';

export type DeliveryOutcome = { reach: DeliveryReach };

/**
 * Map a cursor-write outcome to its delivery reach: a clean `pasted` reached the
 * configured output; a `leftOnClipboard` fallback is a reduced reach. Pure so the
 * reach policy can be read and tested without delivery's clipboard/settings IO.
 */
export function reachForCursorWrite(outcome: WriteTextOutcome): DeliveryReach {
	return outcome === 'pasted' ? 'output' : 'clipboard';
}

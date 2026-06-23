/**
 * The shared `KeyBinding` core: parse, serialize, label, and match the
 * structured physical binding both shortcut tiers speak. No Tauri dependency and
 * no DOM side effects; the only DOM contact is reading `KeyboardEvent` fields
 * (`.code`, the modifier flags) in {@link domCodeToKey} and {@link eventModifiers},
 * which is the capture side of the same physical-key model.
 */

import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';

/**
 * How far a shortcut fires, ordered `focused < global`. The one reach scale,
 * shared by a command's intrinsic ceiling, a key's capability, the platform, and
 * the realized minimum of the three. There is no separate "system" word: a
 * binding whose realized reach is `global` is the one that lives in the
 * per-device store. See ADR-0052.
 */
export type Reach = 'focused' | 'global';

/**
 * A binding for display/dedup purposes. Accepts both the IPC `KeyBinding`
 * (`keys: Key[]`) and the stored shape (`keys: string[]`, validated structurally
 * in device-config and by name in Rust), so the same helpers serve both.
 */
export type BindingLike = {
	modifiers: readonly Modifier[];
	keys: readonly string[];
};

const MODIFIER_LABELS_APPLE: Record<Modifier, string> = {
	ctrl: '⌃',
	alt: '⌥',
	shift: '⇧',
	meta: '⌘',
	fn: 'fn',
};

const MODIFIER_LABELS_OTHER: Record<Modifier, string> = {
	ctrl: 'Ctrl',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: 'Fn',
};

// Fixed display order so the same binding always renders the same way.
const MODIFIER_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'meta', 'fn'];

const KEY_LABELS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Esc',
	backspace: '⌫',
	delete: 'Del',
	insert: 'Ins',
	upArrow: '↑',
	downArrow: '↓',
	leftArrow: '←',
	rightArrow: '→',
	home: 'Home',
	end: 'End',
	pageUp: 'PgUp',
	pageDown: 'PgDn',
	minus: '-',
	equal: '=',
	leftBracket: '[',
	rightBracket: ']',
	semiColon: ';',
	quote: "'",
	backQuote: '`',
	backSlash: '\\',
	comma: ',',
	dot: '.',
	slash: '/',
};

function keyLabel(key: string): string {
	const named = KEY_LABELS[key];
	if (named) return named;
	if (key.startsWith('key')) return key.slice(3); // keyD -> D
	if (key.startsWith('num')) return key.slice(3); // num1 -> 1
	if (/^f\d+$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return key;
}

/**
 * Render a binding as a compact label: `⌘⇧D` on macOS, `Ctrl+Shift+D`
 * elsewhere. Modifiers come first in a fixed order, then keys. An empty binding
 * renders as the empty string (callers show a placeholder).
 */
export function keyBindingToLabel(
	binding: BindingLike,
	isApple: boolean,
): string {
	const labels = isApple ? MODIFIER_LABELS_APPLE : MODIFIER_LABELS_OTHER;
	const separator = isApple ? '' : '+';
	const modifiers = MODIFIER_ORDER.filter((modifier) =>
		binding.modifiers.includes(modifier),
	).map((modifier) => labels[modifier]);
	const keys = binding.keys.map(keyLabel);
	return [...modifiers, ...keys].join(separator);
}

/**
 * Accelerator modifier tokens for `tauri-plugin-global-shortcut`. `meta` becomes
 * `Super`, which the global-hotkey parser maps to Command on macOS and the
 * Super/Windows key elsewhere. `fn` has no accelerator spelling (Carbon's
 * `RegisterEventHotKey` cannot bind it), so a binding that needs Fn is not a
 * Tier-0 chord and {@link keyBindingToAccelerator} returns `null` for it.
 */
const ACCELERATOR_MODIFIERS: Record<Modifier, string | null> = {
	ctrl: 'Control',
	alt: 'Alt',
	shift: 'Shift',
	meta: 'Super',
	fn: null,
};

/** `Key` -> a global-hotkey `Code` token (the parser is case-insensitive). */
const ACCELERATOR_KEYS: Record<string, string> = {
	space: 'Space',
	return: 'Enter',
	tab: 'Tab',
	escape: 'Escape',
	backspace: 'Backspace',
	delete: 'Delete',
	insert: 'Insert',
	upArrow: 'ArrowUp',
	downArrow: 'ArrowDown',
	leftArrow: 'ArrowLeft',
	rightArrow: 'ArrowRight',
	home: 'Home',
	end: 'End',
	pageUp: 'PageUp',
	pageDown: 'PageDown',
	minus: 'Minus',
	equal: 'Equal',
	leftBracket: 'BracketLeft',
	rightBracket: 'BracketRight',
	semiColon: 'Semicolon',
	quote: 'Quote',
	backQuote: 'Backquote',
	backSlash: 'Backslash',
	comma: 'Comma',
	dot: 'Period',
	slash: 'Slash',
};

function acceleratorKey(key: string): string | null {
	const named = ACCELERATOR_KEYS[key];
	if (named) return named;
	if (/^key[A-Z]$/.test(key)) return `Key${key.slice(3)}`; // keyD -> KeyD
	if (/^num[0-9]$/.test(key)) return `Digit${key.slice(3)}`; // num1 -> Digit1
	if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return key.toUpperCase(); // f1 -> F1
	return null;
}

/**
 * Render a binding as a `tauri-plugin-global-shortcut` accelerator string (for
 * example `Control+Shift+Space`), or `null` when it is not a Tier-0 chord the
 * plugin can register. A binding is not Tier-0 when it carries Fn (no
 * accelerator spelling) or is not exactly one key plus at least one modifier:
 * Fn holds and modifier-only holds belong to the Tier-1 keyboard tap, which the
 * caller routes separately. Modifiers are emitted in a fixed order so the same
 * binding always produces the same accelerator.
 */
export function keyBindingToAccelerator(binding: BindingLike): string | null {
	const [key, ...rest] = binding.keys;
	if (!key || rest.length > 0) return null; // accelerators carry exactly one key
	if (binding.modifiers.length === 0) return null; // a bare key is not a gesture
	const modifiers: string[] = [];
	for (const modifier of MODIFIER_ORDER) {
		if (!binding.modifiers.includes(modifier)) continue;
		const token = ACCELERATOR_MODIFIERS[modifier];
		if (!token) return null; // fn -> Tier-1 tap, not the plugin
		modifiers.push(token);
	}
	const keyToken = acceleratorKey(key);
	if (!keyToken) return null;
	return [...modifiers, keyToken].join('+');
}

/**
 * Which backend can execute a binding. A Tier-0 `chord` registers through the
 * permission-free `tauri-plugin-global-shortcut` and carries the accelerator
 * string it registers under; a `tap` binding (an Fn or modifier-only hold) is
 * owned by the Tier-1 rdev tap behind the Accessibility grant and matched on its
 * structured `KeyBinding`, so it needs no accelerator.
 */
export type ResolvedBinding =
	| { tier: 'chord'; accelerator: string }
	| { tier: 'tap' };

/**
 * The single owner of the Tier-0/Tier-1 split. Resolves a binding to its backend
 * and, for a chord, computes the accelerator once here so the partition and the
 * plugin registration never re-derive it. {@link isTierZeroChord} is the boolean
 * view of this for callers that only need the predicate.
 */
export function resolveBinding(binding: BindingLike): ResolvedBinding {
	const accelerator = keyBindingToAccelerator(binding);
	return accelerator !== null
		? { tier: 'chord', accelerator }
		: { tier: 'tap' };
}

/**
 * Whether a binding is a Tier-0 chord: a gesture the permission-free
 * `tauri-plugin-global-shortcut` can register with no Accessibility grant. The
 * boolean view of {@link resolveBinding}; an Fn hold or a modifier-only hold is
 * not Tier-0 and belongs to the Tier-1 keyboard tap.
 */
export function isTierZeroChord(binding: BindingLike): boolean {
	return resolveBinding(binding).tier === 'chord';
}

/**
 * A reach with whether reaching that far needs the macOS Accessibility grant.
 * The shape of both a key's capability and the realized outcome, since the
 * Accessibility need is a property of the gesture that survives (or does not) the
 * reach min().
 */
export type ReachWithGrant = { reach: Reach; needsAccessibility: boolean };

/**
 * How far a key can fire, by its physical shape alone (the second term of the
 * reach formula, ADR-0052). A chord (a non-Fn modifier plus a key) fires
 * globally with no permission. A bare key (a single key, no modifiers) can only
 * fire in-app: bound globally it would swallow that key in every app, so it caps
 * at `focused`. Everything else (an Fn hold, a modifier-only hold, an Fn+key
 * hold) fires globally but only behind the Accessibility grant (ADR-0019).
 * Callers pass a non-empty binding.
 */
export function keyCapability(binding: BindingLike): ReachWithGrant {
	if (isTierZeroChord(binding))
		return { reach: 'global', needsAccessibility: false };
	const isBareKey = binding.modifiers.length === 0 && binding.keys.length === 1;
	if (isBareKey) return { reach: 'focused', needsAccessibility: false };
	return { reach: 'global', needsAccessibility: true };
}

/** `focused` is more restrictive than `global`; the smaller reach wins a min(). */
const REACH_RANK: Record<Reach, number> = { focused: 0, global: 1 };

function minReach(a: Reach, b: Reach): Reach {
	return REACH_RANK[b] < REACH_RANK[a] ? b : a;
}

/**
 * The reach a binding actually achieves for a command on a platform: the minimum
 * of the command's intrinsic ceiling, the key's capability, and what the
 * platform allows (web caps at `focused`, desktop reaches `global`). The most
 * restrictive wins, so reach only ever clamps down, never up. The Accessibility
 * grant requirement is carried through only when the realized reach is still
 * `global`; a gesture clamped to `focused` (a hold on web, a chord on a focused
 * command) needs no grant. This is the one place the reach formula lives, fed
 * `command.reach` and a `platformReach` so it stays free of catalog and platform
 * imports. See ADR-0052.
 */
export function realizedReach(
	commandReach: Reach,
	binding: BindingLike,
	platformReach: Reach,
): ReachWithGrant {
	const key = keyCapability(binding);
	const reach = minReach(minReach(commandReach, key.reach), platformReach);
	return {
		reach,
		needsAccessibility: reach === 'global' && key.needsAccessibility,
	};
}

/**
 * Inverse of {@link ACCELERATOR_KEYS}: a W3C `KeyboardEvent.code` token back to
 * our `Key`. Built from the same source so the two directions can never drift.
 */
const KEY_BY_ACCELERATOR_CODE: Record<string, string> = Object.fromEntries(
	Object.entries(ACCELERATOR_KEYS).map(([key, code]) => [code, key]),
);

/**
 * Map a physical `KeyboardEvent.code` (for example `KeyD`, `Digit1`, `Space`)
 * to our `Key`, or `null` when the code is not a bindable key (a modifier code
 * like `MetaLeft`, or anything outside the Tier-0 chord alphabet). Reading
 * `.code` not `.key` keeps capture in physical-key space, matching the rdev tap
 * and sidestepping the macOS Option-character problem the `.key`-based local
 * recorder has to normalize. The accepted set is exactly the one
 * {@link keyBindingToAccelerator} can spell, so a chord captured here always
 * routes to the permission-free plugin. The inverse of {@link acceleratorKey}.
 */
export function domCodeToKey(code: string): Key | null {
	const named = KEY_BY_ACCELERATOR_CODE[code];
	if (named) return named as Key;
	if (/^Key[A-Z]$/.test(code)) return `key${code.slice(3)}` as Key; // KeyD -> keyD
	if (/^Digit[0-9]$/.test(code)) return `num${code.slice(5)}` as Key; // Digit1 -> num1
	if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase() as Key; // F1 -> f1
	return null;
}

/**
 * Read the live modifier set from a `KeyboardEvent`'s boolean flags rather than
 * its `.code`, so a gesture carries its modifiers no matter which key fired and
 * a stuck modifier-keyup can never strand state (the flags are always current).
 * Fn has no flag (and no `.code`), so a webview capture or the browser matcher
 * can never produce an Fn modifier: that is exactly why Fn holds belong to the
 * Tier-1 native tap, not the in-app tier. Shared by the chord recorder and the
 * browser matcher so both read modifiers the same way.
 */
export function eventModifiers(e: KeyboardEvent): Modifier[] {
	const modifiers: Modifier[] = [];
	if (e.ctrlKey) modifiers.push('ctrl');
	if (e.altKey) modifiers.push('alt');
	if (e.shiftKey) modifiers.push('shift');
	if (e.metaKey) modifiers.push('meta');
	return modifiers;
}

/** A binding with no modifiers and no keys can never fire; treat it as unset. */
export function isEmptyBinding(binding: BindingLike): boolean {
	return binding.modifiers.length === 0 && binding.keys.length === 0;
}

/** Whether every modifier and key of `subset` is also present in `superset`. */
function isContainedBy(subset: BindingLike, superset: BindingLike): boolean {
	return (
		subset.modifiers.every((m) => superset.modifiers.includes(m)) &&
		subset.keys.every((k) => superset.keys.includes(k))
	);
}

/**
 * Whether two gestures overlap: one is a subset of the other (including equal).
 * The rdev matcher fires on exact set equality with no prefix resolution, so an
 * overlapping pair is unusable: the shorter gesture fires first and shadows the
 * longer. The recorder refuses to save a gesture that overlaps another, which is
 * why a key bound to one gesture (such as the recording key's Fn) cannot appear
 * in any other.
 */
export function bindingsOverlap(a: BindingLike, b: BindingLike): boolean {
	return isContainedBy(a, b) || isContainedBy(b, a);
}

/**
 * Whether two bindings are the same gesture: identical modifier and key sets,
 * order-independent. The browser matcher arms a shortcut when the live held set
 * equals its stored binding, so this is the in-app match test (the rdev tap does
 * the same set-equality natively).
 */
export function bindingsEqual(a: BindingLike, b: BindingLike): boolean {
	return isContainedBy(a, b) && isContainedBy(b, a);
}

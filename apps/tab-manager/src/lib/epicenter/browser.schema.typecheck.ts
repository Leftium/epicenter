/**
 * Type-level assertions verifying our schema stays in sync with Browser API types.
 *
 * This file compiles to nothing at runtime. It exists purely to produce TypeScript
 * errors ("red squigglies") when our schema drifts from `Browser.tabs.Tab`,
 * `Browser.windows.Window`, or `Browser.tabGroups.TabGroup`.
 *
 * How it works:
 * - We strip keys that are intentionally different (composite IDs, multi-device additions)
 * - Then assert that the remaining key sets are identical on both sides
 * - If a key exists in Browser but not our schema → error on `_TabBrowserHasExtra`
 * - If a key exists in our schema but not Browser → error on `_TabSchemaHasExtra`
 *
 * When you see an error here, it means the Chrome API changed (via @wxt-dev/browser update)
 * and our schema needs to be updated to match.
 */

import type { Browser } from 'wxt/browser';
import type { Tab, TabGroup, Window } from './browser.schema';

// ─────────────────────────────────────────────────────────────────────────────
// Utility Types
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves to `true` if T is `never`, otherwise `false`. */
type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Asserts that T is `true` at the type level.
 * If T is not `true`, TypeScript will produce an error on the variable using this type.
 */
type Assert<T extends true> = T;

// ─────────────────────────────────────────────────────────────────────────────
// Tab Assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys we intentionally diverge from Browser.tabs.Tab:
 * - `id`: Browser uses `number?`, we use composite `string`
 * - `windowId`: Browser uses `number`, we use composite `string`
 * - `groupId`: Browser uses `number`, we use composite `string?`
 * - `openerTabId`: Browser uses `number?`, we use composite `string?`
 * - `mutedInfo`: Browser uses `MutedInfo?` object, we flatten to `muted?: boolean`
 * - `selected`: Browser has it (deprecated), we intentionally omit
 * - `deviceId`, `tabId`: Our multi-device additions (not in Browser)
 */
type TabBrowserExclude =
	| 'id'
	| 'windowId'
	| 'groupId'
	| 'openerTabId'
	| 'mutedInfo'
	| 'selected';
type TabSchemaExclude =
	| 'id'
	| 'windowId'
	| 'groupId'
	| 'openerTabId'
	| 'muted'
	| 'deviceId'
	| 'tabId';

type TabBrowserKeys = Exclude<keyof Browser.tabs.Tab, TabBrowserExclude>;
type TabSchemaKeys = Exclude<keyof Tab, TabSchemaExclude>;

/** Keys in Browser.tabs.Tab that are missing from our Tab schema. Fix: add them to browser.schema.ts */
type TabMissingFromSchema = Exclude<TabBrowserKeys, TabSchemaKeys>;
/** Keys in our Tab schema that don't exist in Browser.tabs.Tab. Fix: remove them or add to TabSchemaExclude */
type TabExtraInSchema = Exclude<TabSchemaKeys, TabBrowserKeys>;

// These will error if the key sets don't match:
type _TabBrowserHasExtra = Assert<IsNever<TabMissingFromSchema>>;
type _TabSchemaHasExtra = Assert<IsNever<TabExtraInSchema>>;

// ─────────────────────────────────────────────────────────────────────────────
// Window Assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys we intentionally diverge from Browser.windows.Window:
 * - `id`: Browser uses `number?`, we use composite `string`
 * - `tabs`: Browser embeds `Tab[]?`, we normalize into separate table
 * - `deviceId`, `windowId`: Our multi-device additions
 */
type WindowBrowserExclude = 'id' | 'tabs';
type WindowSchemaExclude = 'id' | 'deviceId' | 'windowId';

type WindowBrowserKeys = Exclude<
	keyof Browser.windows.Window,
	WindowBrowserExclude
>;
type WindowSchemaKeys = Exclude<keyof Window, WindowSchemaExclude>;

/** Keys in Browser.windows.Window missing from our Window schema. */
type WindowMissingFromSchema = Exclude<WindowBrowserKeys, WindowSchemaKeys>;
/** Keys in our Window schema not in Browser.windows.Window. */
type WindowExtraInSchema = Exclude<WindowSchemaKeys, WindowBrowserKeys>;

type _WindowBrowserHasExtra = Assert<IsNever<WindowMissingFromSchema>>;
type _WindowSchemaHasExtra = Assert<IsNever<WindowExtraInSchema>>;

// ─────────────────────────────────────────────────────────────────────────────
// TabGroup Assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Keys we intentionally diverge from Browser.tabGroups.TabGroup:
 * - `id`: Browser uses `number`, we use composite `string`
 * - `windowId`: Browser uses `number`, we use composite `string`
 * - `deviceId`, `groupId`: Our multi-device additions
 */
type TabGroupBrowserExclude = 'id' | 'windowId';
type TabGroupSchemaExclude = 'id' | 'windowId' | 'deviceId' | 'groupId';

type TabGroupBrowserKeys = Exclude<
	keyof Browser.tabGroups.TabGroup,
	TabGroupBrowserExclude
>;
type TabGroupSchemaKeys = Exclude<keyof TabGroup, TabGroupSchemaExclude>;

/** Keys in Browser.tabGroups.TabGroup missing from our TabGroup schema. */
type TabGroupMissingFromSchema = Exclude<
	TabGroupBrowserKeys,
	TabGroupSchemaKeys
>;
/** Keys in our TabGroup schema not in Browser.tabGroups.TabGroup. */
type TabGroupExtraInSchema = Exclude<TabGroupSchemaKeys, TabGroupBrowserKeys>;

type _TabGroupBrowserHasExtra = Assert<IsNever<TabGroupMissingFromSchema>>;
type _TabGroupSchemaHasExtra = Assert<IsNever<TabGroupExtraInSchema>>;

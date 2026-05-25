/**
 * Get the runtime's local IANA timezone identifier.
 *
 * Useful as the default timezone for natural-language input when the user
 * has not explicitly chosen one. Delegates to `Intl`, so the value comes
 * from the current environment rather than a hard-coded guess.
 *
 * @returns The environment's resolved IANA timezone.
 *
 * @example
 * ```typescript
 * const timezone = localTimezone();
 * // "America/Los_Angeles"
 * ```
 */
export function localTimezone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

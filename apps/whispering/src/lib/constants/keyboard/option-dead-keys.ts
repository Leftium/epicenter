/**
 * Set of keys that act as "dead keys" with Option on macOS.
 * These don't produce a character immediately but wait for the next key
 * to create accented characters (e.g., Option+E then A = "á").
 */
export const OPTION_DEAD_KEYS = new Set(['e', 'i', 'n', 'u', '`']);

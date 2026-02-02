import { regex } from 'arkregex';

/** Function key pattern: matches f1-f12 */
export const FUNCTION_KEY_PATTERN = regex('^f\\d{1,2}$');

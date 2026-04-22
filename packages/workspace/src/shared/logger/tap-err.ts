import type { AnyTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Result-flow version of `log.warn(err)` / `log.error(err)`.
 *
 * Takes a log *method*, not a logger — caller picks the level at the
 * pipeline site. Matches Rust's `.inspect_err` and Effect's `tapErrorCause`.
 *
 * ```ts
 * const result = await tryAsync({
 *   try: () => writeTable(path),
 *   catch: (cause) => MarkdownError.TableWrite({ path, cause }),
 * }).then(tapErr(log.warn));
 * ```
 */
export function tapErr<T, E extends AnyTaggedError>(
	logFn: (err: E) => void,
): (result: Result<T, E>) => Result<T, E> {
	return (result) => {
		if (result.error) logFn(result.error);
		return result;
	};
}

import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';

/**
 * A signed-in account identifier. Issued by Better Auth, opaque to clients.
 * In personal mode, the bytes happen to equal the owner id; in team mode
 * they do not. The brand prevents accidental cross-assignment.
 *
 * The validator is declared first; the type is derived from it via `.infer`
 * so schema and type stay in lockstep under one PascalCase name. Use
 * {@link UserId} directly inside schemas (`id: UserId`); at trusted call
 * sites that receive a known `string`, brand it with {@link asUserId}.
 */
export const UserId = type('string').as<string & Brand<'UserId'>>();
export type UserId = typeof UserId.infer;
/**
 * Syntactic sugar for `value as UserId`. The function body is a single typed
 * cast; the constrained `string` parameter is what earns it over a raw `as`
 * (callers can't accidentally widen to `unknown`). The only place in the
 * codebase where `as UserId` appears.
 */
export const asUserId = (value: string): UserId => value as UserId;

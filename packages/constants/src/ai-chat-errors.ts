import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the `/ai/chat` endpoint.
 *
 * Defined once in the shared constants package so both server and client
 * reference the same discriminated union. The server calls the factories
 * at runtime (`AiChatError.Unauthorized()`); the client imports only the
 * `AiChatError` type via `InferErrors` for zero-cost type narrowing.
 *
 * Each variant's `name` field is the discriminant—use `switch (error.name)`
 * for exhaustive handling with full TypeScript narrowing.
 *
 * Each variant carries its own HTTP `status`, so call sites just forward
 * the baked-in code to `c.json`. No external status mapper required.
 *
 * @example
 * ```ts
 * // Server: runtime usage
 * import { AiChatError } from '@epicenter/constants/ai-chat-errors';
 * const err = AiChatError.InsufficientCredits({ balance: 42 });
 * return c.json(err, err.error.status); // 402, baked into the variant
 *
 * // Client: type-only usage
 * import { AiChatHttpError } from '@epicenter/constants/ai-chat-errors';
 * if (err instanceof AiChatHttpError) {
 *   switch (err.detail.name) {
 *     case 'Unauthorized': // show sign-in
 *     case 'InsufficientCredits': // err.detail.balance
 *   }
 * }
 * ```
 */
export const AiChatError = defineErrors({
	Unauthorized: () => ({
		message: 'Unauthorized',
		status: 401 as const,
	}),
	ProviderNotConfigured: ({ provider }: { provider: string }) => ({
		message: `${provider} not configured`,
		status: 503 as const,
		provider,
	}),
	UnknownModel: ({ model }: { model: string }) => ({
		message: `Unknown model: ${model}`,
		status: 400 as const,
		model,
	}),
	InsufficientCredits: ({ balance }: { balance: unknown }) => ({
		message: 'Insufficient credits',
		status: 402 as const,
		balance,
	}),
	ModelRequiresPaidPlan: ({
		model,
		credits,
	}: {
		model: string;
		credits: number;
	}) => ({
		message: `${model} requires a paid plan (costs ${credits} credits)`,
		status: 403 as const,
		model,
		credits,
	}),
});

/**
 * Discriminated union of all AI chat error payloads.
 *
 * Reused by both server (runtime) and client (type narrowing).
 * The `name` field discriminates variants in `switch` statements.
 *
 * @example
 * ```ts
 * function handleError(error: AiChatError) {
 *   switch (error.name) {
 *     case 'InsufficientCredits':
 *       console.log(error.balance); // TypeScript knows this exists
 *       break;
 *     case 'ModelRequiresPaidPlan':
 *       console.log(error.model, error.credits); // narrowed
 *       break;
 *   }
 * }
 * ```
 */
export type AiChatError = InferErrors<typeof AiChatError>;

/**
 * Error subclass that carries structured error data across TanStack AI's
 * throw boundary.
 *
 * Created by `createAiChatFetch` when the server returns a non-2xx response
 * with a wellcrafted `{ data, error }` JSON envelope. The `Error` propagates
 * unchanged through TanStack AI's `ChatClient` pipeline; `instanceof
 * AiChatHttpError` works in `onError` and when reading `chat.error`.
 *
 * The `detail` property carries the full discriminated union with
 * variant-specific fields, including the baked-in HTTP `status`. Use
 * `switch (err.detail.name)` for exhaustive handling.
 *
 * @example
 * ```ts
 * if (err instanceof AiChatHttpError) {
 *   console.log(err.detail.status); // 402
 *   console.log(err.detail.name);   // "InsufficientCredits"
 *   switch (err.detail.name) {
 *     case 'InsufficientCredits':
 *       console.log(err.detail.balance); // narrowed
 *       break;
 *   }
 * }
 * ```
 */
export class AiChatHttpError extends Error {
	override readonly name = 'AiChatHttpError';

	constructor(readonly detail: AiChatError) {
		super(detail.message);
	}
}

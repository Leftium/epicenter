import {
	type Accessor,
	type CreateMutationOptions,
	type CreateMutationResult,
	createMutation,
	type QueryClient,
} from '@tanstack/svelte-query';
import { mutationOptions } from 'wellcrafted/query';
import type { Result } from 'wellcrafted/result';

/**
 * TanStack mutation options after translating the Result payload into
 * TanStack's data and error channels.
 *
 * The public API stays on `createResultMutation`. Keeping this type private
 * avoids teaching callers a second options name for the same component-local
 * mutation shape.
 */
type ResultMutationOptions<
	TData,
	TError,
	TVariables = void,
	TContext = unknown,
> = Omit<
	CreateMutationOptions<TData, TError, TVariables, TContext>,
	'mutationFn'
> & {
	mutationKey: readonly unknown[];
	mutationFn: (
		variables: TVariables,
	) => Result<TData, TError> | Promise<Result<TData, TError>>;
};

/**
 * Creates a Svelte TanStack mutation for operations that already return a
 * `wellcrafted/result`.
 *
 * Use this at component edges when a button or form needs TanStack lifecycle
 * state, but the operation should stay as a focused Result-returning function.
 * `Ok(data)` becomes `mutation.data`; `Err(error)` becomes `mutation.error`, so
 * lifecycle callbacks and template reads preserve the operation's own success
 * and error types.
 *
 * Prefer calling TanStack's `createMutation` with Wellcrafted's
 * `mutationOptions` directly. This helper stays as a compatibility wrapper for
 * older internal call sites.
 *
 * Promote the operation to a shared `defineMutation` only when it needs a stable
 * mutation key, shared invalidation, optimistic updates, or multiple consumers.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 * 	const startSignIn = createResultMutation(() => ({
 * 		mutationKey: ['auth', 'startSignIn'],
 * 		mutationFn: () => auth.startSignIn(),
 * 	}));
 *
 * </script>
 *
 * {#if startSignIn.error}
 * 	<p>{startSignIn.error.message}</p>
 * {/if}
 *
 * <Button onclick={() => startSignIn.mutate()} disabled={startSignIn.isPending}>
 * 	{startSignIn.isPending ? 'Signing in...' : 'Sign in'}
 * </Button>
 * ```
 */
export function createResultMutation<
	TData,
	TError,
	TVariables = void,
	TContext = unknown,
>(
	options: Accessor<ResultMutationOptions<TData, TError, TVariables, TContext>>,
	queryClient?: Accessor<QueryClient>,
): CreateMutationResult<TData, TError, TVariables, TContext> {
	return createMutation(
		() => mutationOptions<TData, TError, TVariables, TContext>(options()),
		queryClient,
	);
}

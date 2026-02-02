import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';

/**
 * QueryClient for the Tab Manager extension
 *
 * Since the popup is short-lived, we use aggressive stale times
 * and refetch on window focus to ensure data is fresh.
 */
export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 30, // 30 seconds
			gcTime: 1000 * 60 * 5, // 5 minutes
			refetchOnWindowFocus: true,
			retry: 1,
		},
		mutations: {
			retry: 0,
		},
	},
});

/**
 * Query and mutation factories from wellcrafted
 * These provide the dual interface pattern:
 * - .options for reactive use with createQuery/createMutation (wrap in accessor: () => x.options)
 * - .fetch()/.execute() for imperative use
 */
export const { defineQuery, defineMutation } =
	createQueryFactories(queryClient);

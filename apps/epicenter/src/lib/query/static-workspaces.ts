import { createTaggedError } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import {
	addStaticWorkspace,
	listStaticWorkspaces,
} from '$lib/services/static-workspaces';
import type { StaticWorkspaceEntry } from '$lib/static-workspaces/types';
import { defineMutation, defineQuery, queryClient } from './client';

const { StaticWorkspaceErr } = createTaggedError('StaticWorkspaceError');

const staticWorkspaceKeys = {
	all: ['static-workspaces'] as const,
	list: () => [...staticWorkspaceKeys.all, 'list'] as const,
};

export const staticWorkspaces = {
	/**
	 * List all static workspaces from the registry.
	 */
	listStaticWorkspaces: defineQuery({
		queryKey: staticWorkspaceKeys.list(),
		queryFn: async () => {
			const entries = await listStaticWorkspaces();
			return Ok(entries);
		},
	}),

	/**
	 * Add a new static workspace to the registry.
	 */
	addStaticWorkspace: defineMutation({
		mutationKey: ['static-workspaces', 'add'],
		mutationFn: async (input: Omit<StaticWorkspaceEntry, 'addedAt'>) => {
			try {
				const entry = await addStaticWorkspace(input);
				queryClient.invalidateQueries({
					queryKey: staticWorkspaceKeys.list(),
				});
				return Ok(entry);
			} catch (error) {
				return StaticWorkspaceErr({ message: String(error) });
			}
		},
	}),
};

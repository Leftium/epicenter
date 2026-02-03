import { createTaggedError } from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import {
	addStaticWorkspace,
	getStaticWorkspace,
	listStaticWorkspaces,
	removeStaticWorkspace,
	updateStaticWorkspace,
} from '$lib/services/static-workspaces';
import type { StaticWorkspaceEntry } from '$lib/static-workspaces/types';
import { defineMutation, defineQuery, queryClient } from './client';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export const { StaticWorkspaceError, StaticWorkspaceErr } =
	createTaggedError('StaticWorkspaceError');
export type StaticWorkspaceError = ReturnType<typeof StaticWorkspaceError>;

// ─────────────────────────────────────────────────────────────────────────────
// Query Keys
// ─────────────────────────────────────────────────────────────────────────────

const staticWorkspaceKeys = {
	all: ['static-workspaces'] as const,
	list: () => [...staticWorkspaceKeys.all, 'list'] as const,
	detail: (id: string) => [...staticWorkspaceKeys.all, 'detail', id] as const,
};

// ─────────────────────────────────────────────────────────────────────────────
// Queries & Mutations
// ─────────────────────────────────────────────────────────────────────────────

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
	 * Get a single static workspace entry by ID.
	 */
	getStaticWorkspace: (id: string) =>
		defineQuery({
			queryKey: staticWorkspaceKeys.detail(id),
			queryFn: async () => {
				const entry = await getStaticWorkspace(id);
				if (!entry) {
					return StaticWorkspaceErr({
						message: `Static workspace "${id}" not found`,
					});
				}
				return Ok(entry);
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

	/**
	 * Update an existing static workspace entry.
	 */
	updateStaticWorkspace: defineMutation({
		mutationKey: ['static-workspaces', 'update'],
		mutationFn: async (input: {
			id: string;
			updates: Partial<Omit<StaticWorkspaceEntry, 'id' | 'addedAt'>>;
		}) => {
			const entry = await updateStaticWorkspace(input.id, input.updates);
			if (!entry) {
				return StaticWorkspaceErr({
					message: `Static workspace "${input.id}" not found`,
				});
			}
			queryClient.invalidateQueries({
				queryKey: staticWorkspaceKeys.list(),
			});
			queryClient.invalidateQueries({
				queryKey: staticWorkspaceKeys.detail(input.id),
			});
			return Ok(entry);
		},
	}),

	/**
	 * Remove a static workspace from the registry.
	 */
	removeStaticWorkspace: defineMutation({
		mutationKey: ['static-workspaces', 'remove'],
		mutationFn: async (id: string) => {
			const removed = await removeStaticWorkspace(id);
			if (!removed) {
				return StaticWorkspaceErr({
					message: `Static workspace "${id}" not found`,
				});
			}
			queryClient.invalidateQueries({
				queryKey: staticWorkspaceKeys.list(),
			});
			return Ok(undefined);
		},
	}),
};

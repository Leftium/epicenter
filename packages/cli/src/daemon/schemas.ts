/**
 * Arktype schemas for the wire bodies of `epicenter up`'s IPC routes.
 *
 * These exist for two reasons:
 *
 * 1. **Runtime validation at the daemon boundary** via
 *    `@hono/standard-validator`. A stale CLI calling a current daemon (or
 *    vice versa) gets a typed 400 instead of a confusing downstream cast
 *    failure.
 * 2. **Compile-time inference for the `hc` typed client.** Hono's `hc<App>`
 *    derives the input type of each route from its validator, so call
 *    sites get checked against these shapes without redeclaring them.
 *
 * The arktype types here are the *wire* shape. They're a strict subset of
 * the in-memory `ListCtx` / `RunCtx` types in `commands/list.ts` and
 * `commands/run.ts` (those types include cleanup we did inline in the
 * dispatcher). The cast back to the in-memory type is one line per route.
 */

import { type } from 'arktype';

const listMode = type({ kind: '"local"' })
	.or({ kind: '"all"' })
	.or({ kind: '"peer"', deviceId: 'string' });

export const peersArgsSchema = type({
	'workspace?': 'string',
});
export type PeersArgs = typeof peersArgsSchema.infer;

export const listCtxSchema = type({
	path: 'string',
	mode: listMode,
	waitMs: 'number',
	'workspace?': 'string',
});
export type ListCtx = typeof listCtxSchema.infer;

export const runCtxSchema = type({
	actionPath: 'string',
	input: 'unknown',
	'peerTarget?': 'string',
	waitMs: 'number',
	'workspaceArg?': 'string',
});
export type RunCtx = typeof runCtxSchema.infer;

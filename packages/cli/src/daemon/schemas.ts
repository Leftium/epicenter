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
 * The schemas reflect the "CLI shortcut == one workspace primitive" model:
 *
 *   /list   ->  describeActions(workspace.actions)             local only
 *   /peers  ->  workspace.sync.peers()
 *   /run    ->  invokeAction (local) or sync.rpc (remote, via peerTarget)
 */

import { type } from 'arktype';

export const peersArgsSchema = type({
	'workspace?': 'string',
});
export type PeersArgs = typeof peersArgsSchema.infer;

export const listCtxSchema = type({
	'workspace?': 'string',
});
export type ListCtx = typeof listCtxSchema.infer;

export const runCtxSchema = type({
	actionPath: 'string',
	input: 'unknown',
	'peerTarget?': 'string',
	waitMs: 'number',
	'workspace?': 'string',
});
export type RunCtx = typeof runCtxSchema.infer;

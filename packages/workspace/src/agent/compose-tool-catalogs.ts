/**
 * Compose several {@link ToolCatalog}s into one the agent loop consumes
 * unchanged. The loop is handed a single catalog; an app that reaches tools more
 * than one way (its in-process actions through {@link createDispatchToolCatalog}
 * PLUS one {@link createMcpGatewayCatalog} per cross-device route it has dialed
 * over the relay floor) merges them here.
 *
 * Collision rule: first-wins. A tool name that appears in more than one catalog
 * is owned by the EARLIEST catalog in the list, for both the offered definition
 * and the `resolve` that runs it. Pass the local in-process catalog first so a
 * local action shadows a same-named remote tool, matching the dispatch catalog's
 * own "a local action shadows a remote one" rule.
 *
 * The source may be a live getter: `definitions()` and `resolve()` re-read it on
 * every call, so an app that mounts or unmounts a device's catalog over time
 * passes `() => [local, ...mounted]` and the merged surface tracks the change
 * with no re-wiring of the loop.
 */

import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/**
 * Merge `source` into one catalog. `source` is either a fixed array or a getter
 * read live on each call (use the getter when the set of catalogs changes over
 * the loop's life).
 */
export function composeToolCatalogs(
	source: readonly ToolCatalog[] | (() => readonly ToolCatalog[]),
): ToolCatalog {
	const catalogs: () => readonly ToolCatalog[] =
		typeof source === 'function' ? source : () => source;

	function definitions(): AgentToolDefinition[] {
		const byName = new Map<string, AgentToolDefinition>();
		for (const catalog of catalogs()) {
			for (const definition of catalog.definitions()) {
				if (!byName.has(definition.name))
					byName.set(definition.name, definition);
			}
		}
		return [...byName.values()];
	}

	async function resolve(
		call: AgentToolCall,
		signal: AbortSignal,
	): Promise<AgentToolOutcome> {
		for (const catalog of catalogs()) {
			const owns = catalog
				.definitions()
				.some((definition) => definition.name === call.toolName);
			if (owns) return catalog.resolve(call, signal);
		}
		return {
			output: `No tool named ${call.toolName} is available.`,
			isError: true,
		};
	}

	return { definitions, resolve };
}

/**
 * Wrap a {@link ToolCatalog} so every tool name is prefixed, keeping two
 * sources' same-named tools distinct in a composed surface.
 *
 * Cross-device tools auto-mount one catalog per (device, route) over the relay
 * floor. Two devices that both serve `local-books` expose a tool literally named
 * `customers`; merged under {@link composeToolCatalogs}'s first-wins rule, the
 * second would vanish and every `customers` call would route to the first.
 * Prefixing each device's tools (`<deviceKey>__customers`) makes them coexist:
 * the model sees distinct names, and `resolve` strips the prefix before
 * delegating. The local in-process catalog stays UNprefixed, so its names are the
 * plain ones the app's own tools have always had.
 *
 * The prefix must not itself contain the `__` separator (the caller derives it
 * from a sanitized id), but the underlying tool name may: `resolve` slices by the
 * known prefix length, never by searching for `__`.
 */

import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/** Separator between the namespace prefix and the underlying tool name. */
const SEPARATOR = '__';

/**
 * Return a catalog whose tools are `${prefix}__${name}`. `prefix` should be a
 * stable, collision-free key for the source (e.g. a short device id plus route)
 * containing no `__`.
 */
export function namespaceToolCatalog(
	prefix: string,
	catalog: ToolCatalog,
): ToolCatalog {
	const qualified = `${prefix}${SEPARATOR}`;
	return {
		definitions(): AgentToolDefinition[] {
			return catalog.definitions().map((definition) => ({
				...definition,
				name: `${qualified}${definition.name}`,
			}));
		},
		resolve(
			call: AgentToolCall,
			signal: AbortSignal,
		): Promise<AgentToolOutcome> {
			if (!call.toolName.startsWith(qualified)) {
				return Promise.resolve({
					output: `No tool named ${call.toolName} is available.`,
					isError: true,
				});
			}
			const bareName = call.toolName.slice(qualified.length);
			return catalog.resolve({ ...call, toolName: bareName }, signal);
		},
	};
}

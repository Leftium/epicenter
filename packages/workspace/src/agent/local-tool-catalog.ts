/**
 * The {@link ToolCatalog} of this client's own in-process actions (ADR-0047).
 *
 * Every tool is a local `defineActions` entry, resolved in-process through
 * `invokeAction` with no relay. Cross-device tools are a separate catalog: a
 * peer's explicitly-exposed MCP routes are auto-mounted over the relay floor
 * (`createMcpGatewayCatalog`) and composed beside this one (`composeToolCatalogs`).
 * Keeping the two apart means the local surface never depends on a socket.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import type { JsonValue } from 'wellcrafted/json';
import {
	type Action,
	type ActionRegistry,
	invokeAction,
} from '../shared/actions.js';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

/**
 * Build a tool catalog over a fixed local action registry. `definitions` is
 * re-read on every call so it always reflects the current registry; `resolve`
 * runs the named action in-process and returns its outcome.
 */
export function createLocalToolCatalog(
	localActions: ActionRegistry,
): ToolCatalog {
	function definitions(): AgentToolDefinition[] {
		return Object.entries(localActions).map(([name, action]) =>
			toToolDefinition(name, action),
		);
	}

	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		const action = localActions[call.toolName];
		if (!action) {
			return {
				output: `No local tool named "${call.toolName}".`,
				isError: true,
			};
		}
		const { data, error } = await invokeAction(action, call.input);
		if (error !== null) {
			return { output: extractErrorMessage(error), isError: true };
		}
		return { output: (data ?? null) as JsonValue, isError: false };
	}

	return { definitions, resolve };
}

/** Project a local {@link Action}'s metadata to a tool definition. */
function toToolDefinition(name: string, action: Action): AgentToolDefinition {
	return {
		name,
		kind: action.type,
		...(action.title !== undefined && { title: action.title }),
		...(action.description !== undefined && {
			description: action.description,
		}),
		...(action.input !== undefined && {
			inputSchema: action.input as JsonValue,
		}),
	};
}

export {
	type AuthPluginConfig,
	createAuthPlugin,
	createBetterAuth,
} from './auth';
export {
	createHubSessionValidator,
	type HubSessionValidatorConfig,
	type SessionValidationResult,
} from './auth/local-auth';
export {
	createClientPresence,
	createLocalPresence,
	type DeviceCapability,
	type DeviceType,
	DISCOVERY_ROOM_ID,
	type DiscoveryState,
	getDiscoveredDevices,
} from './discovery';
export { createHubServer, type HubServerConfig } from './hub';
export { createLocalServer, type LocalApp, type LocalServerConfig } from './local';
export {
	createOpenCodeProcess,
	type GenerateConfigOptions,
	generateOpenCodeConfig,
	generateOpenCodeConfigContent,
	type OpenCodeConfig,
	type OpenCodeProcess,
	type OpenCodeProcessConfig,
} from './opencode';
export { createProxyPlugin, type ProxyPluginConfig } from './proxy';
export { DEFAULT_PORT, listenWithFallback } from './server';
export { createWorkspacePlugin } from './workspace';

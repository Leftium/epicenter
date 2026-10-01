/**
 * `@epicenter/capture-app/native`: the Capture folder bridge the Epicenter
 * host mounts.
 *
 * Bun only. The page never imports this; it reaches the folder through
 * `src/lib/bridge/client.ts`.
 */

export { captureDefinition } from '@epicenter/capture';
export {
	type CaptureBridge,
	type CaptureBridgeOptions,
	createCaptureBridge,
} from './bridge.js';

import type { RecorderService } from './types';
import { NavigatorRecorderServiceLive } from './navigator';

export type { RecorderError, RecorderService, Recording } from './types';

export { NavigatorRecorderServiceLive };

/**
 * CPAL is Tauri-only. On web the binding is `null`, so consumers can
 * still import it without a build-time conditional. Callers null-check
 * before use; this is the runtime-DI seam inside the build-time-DI
 * envelope (settings.recording.method = 'cpal' is only ever true inside
 * a Tauri bundle, where `index.tauri.ts` overrides this to the real
 * service).
 */
export const CpalRecorderServiceLive: RecorderService | null = null;

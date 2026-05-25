import { isTauri } from '@tauri-apps/api/core';
import { createAnalyticsServiceDesktop } from './desktop';
import { createAnalyticsServiceWeb } from './web';

export type { AnalyticsError, AnalyticsService, Event } from './types';

export const AnalyticsServiceLive = isTauri()
	? createAnalyticsServiceDesktop()
	: createAnalyticsServiceWeb();

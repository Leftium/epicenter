import { IS_MACOS } from '#platform/os';

export const CommandOrControl = IS_MACOS ? 'Command' : 'Control';

export const CommandOrAlt = IS_MACOS ? 'Command' : 'Alt';

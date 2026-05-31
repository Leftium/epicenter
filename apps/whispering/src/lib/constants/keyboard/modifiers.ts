import { os } from '#platform/os';

export const CommandOrControl = os.isApple ? 'Command' : 'Control';

export const CommandOrAlt = os.isApple ? 'Command' : 'Alt';

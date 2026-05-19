import { defineConfig } from '@epicenter/workspace';
import demo from './workspaces/demo/daemon.ts';

export default defineConfig({ routes: [demo] });

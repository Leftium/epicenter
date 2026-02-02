import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		host: true, // Listen on all network interfaces
		port: 5177,
	},
});

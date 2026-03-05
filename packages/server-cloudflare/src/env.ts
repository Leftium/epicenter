import { createFactory } from 'hono/factory';
import type { auth } from './auth/server';

type ApiKeyBindings = {
	OPENAI_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	GEMINI_API_KEY?: string;
	GROK_API_KEY?: string;
};

type Session = (typeof auth)['$Infer']['Session'];

type Variables = {
	user: Session['user'];
	session: Session['session'];
};

export type AppEnv = {
	Bindings: Cloudflare.Env & ApiKeyBindings;
	Variables: Variables;
};

export const factory = createFactory<AppEnv>();

import type { createAuth } from './auth/better-auth';

export type Bindings = {
	DATABASE_URL: string;
	YJS_ROOM: DurableObjectNamespace;
	SESSION_KV: KVNamespace;
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string; // e.g. https://api.epicenter.so — OAuth issuer
	OPENAI_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	GEMINI_API_KEY?: string;
	GROK_API_KEY?: string;
};

type Auth = ReturnType<typeof createAuth>;
type Session = Auth['$Infer']['Session'];

type Variables = {
	auth: Auth;
	user: Session['user'];
	session: Session['session'];
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

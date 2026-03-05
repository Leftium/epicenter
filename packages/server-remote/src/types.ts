export type ApiKeyBindings = {
	OPENAI_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	GEMINI_API_KEY?: string;
	GROK_API_KEY?: string;
};

export type SessionResult = {
	user: { id: string; name: string; email: string; [key: string]: unknown };
	session: { id: string; [key: string]: unknown };
};

export type Variables = {
	user: SessionResult['user'];
	session: SessionResult['session'];
};

/** Minimal environment shape that the shared routes require. */
export type SharedEnv = {
	Bindings: ApiKeyBindings & Record<string, unknown>;
	Variables: Variables;
};

/**
 * Structural type for the Better Auth instance.
 * Avoids importing `Auth` directly to prevent duplicate-package resolution
 * issues across workspace packages.
 */
export type AuthInstance = {
	handler: (request: Request) => Promise<Response> | Response;
	api: {
		getSession: (opts: {
			headers: Headers;
		}) => Promise<SessionResult | null>;
	};
};

export type SharedAppConfig = {
	/** Better Auth instance for handling auth routes and session validation. */
	auth: AuthInstance;
	/** Additional info for the health endpoint. */
	healthMeta?: Record<string, unknown>;
};

# Anonymous demo generation

`POST /demo/v1/chat/completions` serves the Zhongwen tutor demo without an
account. It is temporary: it exists while Postgres-backed sign-in is down, and
it should be removed once the tutor can use the metered `/v1/chat/completions`
gateway with a session bearer.

Code: `worker/demo-inference.ts` (route) and `worker/demo-budget.ts` (budget
Durable Object). The route touches no Postgres, Better Auth, or Autumn.

## Client contract

Point an OpenAI-compatible SDK at `https://api.epicenter.so/demo/v1` with any
placeholder API key. The key is ignored and never forwarded.

The request body may hold only these fields:

| Field | Rule |
| --- | --- |
| `model` | exactly `zhongwen-tutor` |
| `stream` | exactly `true` |
| `messages` | a non-empty array, each `{ role, content }` with no other keys |

`role` is `system`, `user`, or `assistant`. `content` is a string. Message text totals at most
16,000 characters, counted as UTF-16 code units. The body is at most 64 KiB. A conversation over the text limit remains saved;
start a new practice to generate further demo replies.

Anything else is refused with `400 invalid_request`: tools, functions,
`tool_choice`, `n`, token limits, images, audio, provider keys, message
`name` or `tool_calls`, and any unknown field.

The server sends Gemini a body it builds itself: the validated messages plus
the model selected by `GEMINI_DEMO_MODEL`, `stream: true`, `n: 1`,
`reasoning_effort: minimal`, and
`max_completion_tokens: 2048`. A successful response is the provider's
OpenAI-format SSE stream, byte for byte. For an opening containing only system
instructions, the gateway preserves those instructions under the provider's
user role because Gemini requires contents. It adds no text or saved learner
turn. Existing conversation roles pass through unchanged.

## Model configuration

`GEMINI_DEMO_MODEL` in `wrangler.jsonc` selects the Google model. It currently
uses `gemini-3.5-flash-lite`. The browser requests the stable `zhongwen-tutor`
alias; callers cannot select another provider model. Change the deployment
variable and deploy the API to switch models without rebuilding Zhongwen.
The selected model must support Google's OpenAI-compatible text streaming and
`reasoning_effort: minimal`. The provider key remains a server secret.

## Budget

One Durable Object, `DemoGenerationBudget`, under a fixed server-owned name,
caps every caller together at 10 attempts per clock minute and 100 per UTC
day across all visitors. One caller can use the whole shared budget, which
makes generation unavailable until reset. Counts live in its SQLite storage, so they survive eviction and are exact
under concurrency.

An attempt is counted after the request passes validation and before the
provider is called. Provider errors, timeouts, and client disconnects still
count. Invalid, oversized, and denied requests do not.

## Errors

Validation and failures before streaming use the gateway envelope `{ error: { message, code } }` with a
fixed message. Provider error bodies, provider URLs, and the key are never
returned for those failures. Successful SSE bodies pass through unchanged,
including any midstream provider error frames.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | the body breaks the contract above |
| 413 | `request_too_large` | the body exceeds 64 KiB |
| 429 | `rate_limit_exceeded` | a cap is spent; `Retry-After` gives seconds until it resets |
| 503 | `ProviderNotConfigured` | `GEMINI_API_KEY` or `GEMINI_DEMO_MODEL` is unset; no attempt is counted |
| 503 | `demo_unavailable` | the budget object failed or took over 5 s |
| 502 | `upstream_unreachable`, `upstream_error` | the provider failed before streaming |
| 504 | `upstream_timeout` | the provider did not answer within 90 s |

The 90 s deadline covers the whole provider call, including the stream. A
stream cut by the deadline or by a provider failure ends without a final
`[DONE]` frame.

CORS comes from the global trusted-origin list, which includes
`https://zhongwen.epicenter.so`. It lets the browser read responses; it is not
access control. The route is open to any HTTP client, and the shared budget bounds inference attempts and tokens. It does not
guarantee availability or cap all Cloudflare traffic charges.

# OpenAI-compatible model contract

## Providers

The Host offers every chat provider in the installed `@earendil-works/pi-ai` release (Anthropic,
OpenAI, Google, Vertex, Bedrock, Azure, Mistral, xAI, OpenRouter, GitHub Copilot, ChatGPT Codex,
OpenCode Zen and Go, and the rest). Each provider brings its own sign-in methods: an API key
(some also ask for account or region values), a subscription OAuth flow, or both. pi drives
sign-in; the Host relays its prompts, device codes and sign-in links to Settings, stores the
resulting credential in Host secret storage, and lets pi refresh OAuth tokens under a per-credential
lock. Administrators connect providers for the Host; members connect their own, subject to the
BYOK (API key) and BYOS (subscription) policy. Personal credentials never fall back to the Host's
environment variables or credential files.

OpenCode Zen accepts an empty API key. Its free models are then requested without any
credential; OpenGUI does not identify itself as the OpenCode client.

## Model catalogs

The Host loads each connected provider's metadata from
`https://pi.dev/api/models/providers/{provider}`. It checks connected providers at startup,
after a sign-in, and when clients request models. Successful results are cached under
`model-catalog/` in the Host data directory and revalidated with ETags after four hours.
Requests time out after four seconds. Failed refreshes keep the last cached online models and
back off for four hours. Without a valid cache, no models are offered until the online catalog
becomes available. Concurrent requests share one refresh per provider.

Installed pi-ai model lists are not used for listings, only for trust: an online model is offered
only when its API is one the installed provider implements, and its endpoint and headers always
come from the installed provider, never the remote catalog. Keyless Zen lists only zero-input-cost,
zero-output-cost models. The Frontend displays Host metadata without fetching another catalog.
Custom backends use explicitly configured metadata rather than vendor-name inference. New models
using supported APIs do not require an OpenGUI release. New APIs may.

## Custom endpoints

Custom OpenAI-compatible backends in 0.6 use `POST {baseUrl}/chat/completions` with bearer-token
authentication when an API key is configured. The endpoint must support:

- JSON requests containing `model`, `messages`, `stream: true`, and OpenAI-style `tools`;
- SSE frames prefixed with `data:`, terminated by `data: [DONE]`;
- streamed `choices[].delta.content`, optional reasoning text, and indexed
  `choices[].delta.tool_calls` whose function arguments may arrive in fragments;
- finish reasons `stop`, `tool_calls`, or `function_call`;
- UTF-8 content and standard HTTP status codes for authentication, rate limits, and availability.

Images are sent as OpenAI content parts only for models that accept them. A backend that rejects
image content is retried without image parts and remembered as text-only for the process lifetime.
Unsupported proprietary request fields, non-SSE streaming formats, interactive tool approvals, and
provider-specific Session semantics are outside this compatibility contract.

Custom backends can also route individual models to OpenAI Responses or Anthropic Messages. Those are not evidence that an arbitrary endpoint supports multiple protocols. Validate a
custom endpoint with text, Unicode, tool calls, abort, malformed-stream, rate-limit, and context
limit cases before offering it to other Host members.

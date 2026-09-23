# OpenAI-compatible model contract

## Model catalogs

The Host loads Codex, OpenCode Zen, and OpenCode Go metadata from
`https://pi.dev/api/models/providers/{provider}`. It checks configured providers at startup,
after Codex sign-in, and when clients request models. Successful results are cached under
`model-catalog/` in the Host data directory and revalidated with ETags after four hours.
Requests time out after four seconds. Failed refreshes keep the last cached online models and
back off for four hours. Without a valid cache, no models are offered until the online catalog
becomes available. Concurrent requests share one refresh per provider.

Installed pi-ai model lists are not used for these connections. Only supported model protocols
are offered; keyless Zen lists only zero-input-cost, zero-output-cost models. The Host keeps control of
endpoint URLs and credentials. The Frontend displays Host metadata without fetching another
catalog. Custom backends use explicitly configured metadata rather than vendor-name inference.
New models using supported protocols do not require an OpenGUI release. New protocols may.

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

OpenGUI also has explicit internal routes for Codex Responses and configured Anthropic Messages
models. Those are not evidence that an arbitrary endpoint supports multiple protocols. Validate a
custom endpoint with text, Unicode, tool calls, abort, malformed-stream, rate-limit, and context
limit cases before offering it to other Host members.

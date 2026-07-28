# OpenAI Responses interactive transport contracts

Verified against current official OpenAI primary documentation on 2026-07-26.

## Production contracts

- **Direct API-key WebSocket mode is documented and production-supported.** Connect to `wss://api.openai.com/v1/responses` with bearer authorization and send `response.create`. Its body mirrors Responses create except transport-only `stream` and `background` are omitted. The connection is sequential (one in-flight response), is not multiplexed, and is limited to 60 minutes. [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- **Incremental continuation is connection-local.** Send only new input plus the latest `previous_response_id`. With `store:false`, only the most recent response is retained in volatile connection memory; a reconnect cannot hydrate it. On `previous_response_not_found`, resend full context without the ID. A failed continuation evicts the referenced state. [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- **Reconnect does not authorize replay after visible output.** The official recovery choices are persisted continuation (`store:true`) or a new full-context response (`store:false`). OpenGUI therefore reconnects/falls back only before forwarding output; after any forwarded output it reports the transport failure to avoid duplicate text or tool effects. [WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- **Interactive abort is connection termination.** OpenAI documents terminating the connection to cancel a synchronous response. The `/cancel` endpoint is for background Responses. [Background mode](https://developers.openai.com/api/docs/guides/background)
- **Prompt caching is prefix-based and automatic from 1,024 tokens.** `prompt_cache_key` improves affinity. Cache reads are `usage.input_tokens_details.cached_tokens`; GPT-5.6-family cache writes are `cache_write_tokens`. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- **GPT-5.6 and later families use the new controls.** `prompt_cache_options.mode` is `implicit` or `explicit`; `prompt_cache_options.ttl` currently supports only `30m` and is a minimum lifetime. Supported content blocks may carry `prompt_cache_breakpoint: {mode:"explicit"}`. Older models reject these fields. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- **Earlier listed models use legacy retention.** `prompt_cache_retention:"24h"` remains supported for the documented GPT-5.5/5.4/5.2/5.1/5 and GPT-4.1 families. It is deprecated for GPT-5.6 and later. OpenGUI does not send it to unknown/custom endpoints unless compatibility explicitly opts in. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- **Background mode is resumable but has higher TTFT.** A response created with both `background:true` and `stream:true` can resume from a streaming `sequence_number` via `starting_after`; background data is temporarily persisted even with `store:false`. This is not the default interactive path. [Background mode](https://developers.openai.com/api/docs/guides/background)
- **Webhooks are asynchronous notifications, not interactive delivery.** They follow Standard Webhooks, require raw-body signature verification, can retry for 72 hours, and can be duplicated; `webhook-id` is the documented idempotency key. [Webhooks](https://developers.openai.com/api/docs/guides/webhooks)

## OpenGUI decision

Official direct-key OpenAI Responses uses a Session/principal/Host/model-isolated WebSocket pool in `auto` mode. A connection is never shared concurrently. A transport failure before output falls back once to the existing pi-ai SSE path; a failure after output never replays. `sse` forces pi-ai and `websocket` explicitly requests the same direct production protocol (with the same safe pre-output fallback). Custom Responses endpoints remain on pi-ai SSE.

The WebSocket chain uses `store:false`. It continues incrementally only when the durable context prefix and cache generation still match. A cache-generation change closes the pooled connection. Idle/full-context recovery preserves the durable transcript as source of truth.

OpenGUI does **not** add background runs or webhooks in this slice. The current durable run model owns an interactive iterator and has no separate asynchronous run state machine, persisted provider cursor, webhook-event idempotency table, or owner-configured public callback lifecycle. Adding a webhook endpoint without those primitives could complete the same run twice or bypass current Session arbitration. A future isolated `BackgroundRunTransport` should first add those durable states and Standard Webhooks verification; it must not alter default chat.

## Configuration and diagnostics

- `OPENGUI_MODEL_TRANSPORT=pi-ai|native` (`pi-ai` default). `native` preserves the legacy OpenGUI adapters. Unknown values select `native`.
- `OPENGUI_CODEX_TRANSPORT=auto|websocket|websocket-cached|sse|native` (`auto` default). `native` preserves the legacy Codex SSE adapter. Unknown values select the native adapter.
- `OPENGUI_OPENAI_RESPONSES_TRANSPORT=auto|websocket|sse` (`auto` default)
- Unknown OpenAI Responses transport values fail toward `sse`; unknown diagnostics values remain disabled. Native fallback therefore remains operable even with malformed environment configuration.
- `OPENGUI_OWNER_MODEL_DIAGNOSTICS=1` enables owner-process-only transport diagnostics. Stderr receives only a transport code and opaque connection hash. The optional Codex diagnostic file is bounded to 64 KiB, mode `0600`, and contains only hashed Session/model identifiers, numeric usage/timing, and diagnostic codes—never prompts, identities, headers, payloads, provider messages, or credentials.

Credential-gated live lanes skip cleanly when their key is absent and suppress provider error details:

- `pnpm run test:openai-cache-live` (`OPENAI_API_KEY`, optional `OPENAI_CACHE_SMOKE_MODEL`)
- `pnpm run test:anthropic-cache-live` (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_CACHE_SMOKE_MODEL`)

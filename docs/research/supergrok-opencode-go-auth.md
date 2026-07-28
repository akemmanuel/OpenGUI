# SuperGrok and OpenCode Go authentication research

Research date: 2026-07-11.

## OpenCode Go

OpenCode's official Go documentation describes the supported third-party flow as: subscribe in OpenCode Console, copy an API key, and send it to the Go API. The OpenAI-compatible endpoint is `https://opencode.ai/zen/go/v1/chat/completions`; model discovery is `https://opencode.ai/zen/go/v1/models`. Some catalog models instead use the Anthropic Messages endpoint at `https://opencode.ai/zen/go/v1/messages`.

Source: [OpenCode Go documentation](https://opencode.ai/docs/go/) and [`packages/web/src/content/docs/go.mdx`](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/go.mdx).

OpenCode's own client also has a Console account device flow. It uses client ID `opencode-cli`, starts at `https://console.opencode.ai/auth/device/code`, polls `https://console.opencode.ai/auth/device/token`, refreshes at the same token endpoint, and fetches account-specific provider configuration from `/api/config`. That implementation identifies the OAuth application as the OpenCode CLI; the official Go documentation does not authorize unrelated applications to reuse that OAuth client identity.

Source: [`packages/core/src/plugin/provider/opencode.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/provider/opencode.ts).

**Conclusion:** OpenGUI can safely add OpenCode Go via its documented API-key interface now. Shipping OAuth by reusing `opencode-cli` would identify OpenGUI as another application and is not supported by the published third-party instructions; OpenGUI needs its own client registration or explicit permission from OpenCode.

## xAI public API and experimental SuperGrok OAuth

xAI's documented API-key surface exposes the Responses API at `https://api.x.ai/v1/responses`. The documented `grok-build-0.1` model has a 256,000-token context window; its documented aliases are `grok-code-fast-1`, `grok-code-fast`, and `grok-code-fast-1-0825`. These public API model IDs are separate from the `grok-build` slug accepted by the experimental subscription proxy.

Hermes Agent's public integration uses OIDC discovery at `https://auth.x.ai/.well-known/openid-configuration`, device authorization at `https://auth.x.ai/oauth2/device/code`, and scopes `openid profile email offline_access grok-cli:access api:access`. It uses client ID `b1a00492-073a-47ea-816f-4c329264a828` and refresh-token rotation. OpenGUI's experimental subscription lane sends the proxy-only `grok-build` slug to `https://cli-chat-proxy.grok.com/v1/responses`; it does not present that slug as a public xAI API model.

Sources: [xAI Grok Build 0.1 model documentation](https://docs.x.ai/developers/models/grok-build-0.1), [`NousResearch/hermes-agent`, `hermes_cli/auth.py`](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth.py), and the [Hermes xAI OAuth guide](https://hermes-agent.nousresearch.com/docs/guides/xai-grok-oauth).

The Hermes guide warns that xAI may return HTTP 403 after successful OAuth for accounts whose subscription tier is not enabled for API access. No first-party xAI documentation found in this investigation grants OpenGUI permission to reuse the Grok CLI OAuth client ID.

**Conclusion:** the public xAI API-key lane is supported and uses the documented endpoint, IDs, and context. Subscription-proxy OAuth remains explicitly experimental: OpenGUI is authorizing a third-party Grok CLI client, not an OAuth client registered for OpenGUI. OpenGUI should obtain its own xAI client registration or explicit reuse authorization before presenting that flow as supported first-party subscription authentication.

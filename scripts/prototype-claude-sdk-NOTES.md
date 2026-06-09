# Claude SDK replacement terminal prototype notes

Prototype question:

> Does OpenGUI's local Claude SDK replacement actually work against a real local Claude Code CLI with the options and control callbacks used by `claude-code-bridge.ts`?

Run:

```bash
pnpm run prototype:claude-sdk
```

This is throwaway. Once the SDK replacement is fixed, delete this terminal shell or fold the useful diagnostics into a real smoke/integration test.

Things to try:

1. Action `1`: harmless no-tool query.
2. Action `2`: ask for a tool-using task in a scratch directory with permission policy `ask`.
3. Action `3`: session listing after a successful query.
4. Action `5`: list supported models using the same `supportedModels()` probe path as OpenGUI.
5. Toggle `includePartialMessages`, permission mode, and permission policy to compare behavior.

Verdict / findings:

- Fill in after driving the prototype.


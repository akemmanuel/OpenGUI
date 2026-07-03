# Pi/OpenCode send-message dogfood report

Target: `http://localhost:3000/` (production web build)
Scope: **Pi and OpenCode only**, with `gpt-oss-120b` from Nvidia where possible.

Setup notes:

- `pnpm vp build` completed successfully.
- `pnpm run start:web` was attempted with `nohup`, but port `3000` was already occupied by an existing OpenGUI web server, so I tested against that running instance.
- Project/default chat directory used: `/home/emmanuel/Code/OpenGUI`.

## Findings

### ISSUE-001 — OpenCode Nvidia `gpt-oss-120b` is hidden by “Hide old models”, causing search to prefer Kilo

Severity: High

Correction after retest: OpenCode **can** select Nvidia `gpt-oss-120b`, but only after turning off **Settings → Hide old models** and searching `gpt-oss-120b nvidia`. With the default “Hide old models” enabled, searching `gpt-oss-120b` only exposed **“GPT OSS 120B (Free) Kilo Gateway (Free)”**, which made the Nvidia option look unavailable.

Evidence:

- `screenshots/opencode-gpt-oss-search.png`
- `screenshots/opencode-gpt-oss-nvidia-hide-old-off.png`
- `screenshots/opencode-after-send-no-record.png`

Repro:

1. Open the harness/model chooser from the message composer.
2. Select the **OpenCode** tab.
3. Search `gpt-oss-120b`.
4. Observe the exact match is Kilo Gateway, not Nvidia.
5. Go to Settings → General and turn **Hide old models** off.
6. Search `gpt-oss-120b nvidia` again.
7. Observe **GPT-OSS-120B Nvidia** appears.

Expected: If the requested/current model is available via Nvidia, it should remain discoverable or the hiding policy should explain why it is hidden.

Actual: The default search path hides the Nvidia model and nudges the user to Kilo.

### ISSUE-002 — OpenCode send fails immediately with a Kilo free-period error

Severity: High

After selecting the only OpenCode `gpt-oss-120b` result and sending `Say READY only.`, the session is created but the agent fails with: “Not Found: The free period of this model ended...”

Evidence:

- `screenshots/opencode-after-send-no-record.png`

Repro:

1. Select OpenCode → `GPT OSS 120B (Free)` from the `gpt-oss-120b` search result.
2. Type `Say READY only.`
3. Click **Send message**.

Expected: Message sends through Nvidia `gpt-oss-120b` or selection is blocked before send.

Actual: OpenCode tries Kilo’s expired/free route and errors.

### ISSUE-002B — OpenCode + Nvidia `gpt-oss-120b` sends but remains loading without a response for >60s

Severity: High

After disabling “Hide old models”, selecting **OpenCode → GPT-OSS-120B Nvidia**, and sending `Say READY only.`, the session entered generation state and stayed **Loading... Untitled** for over a minute. The composer changed to **Steer / Stop generating** but no assistant content appeared. Unlike Pi, clicking **Stop generating** did return the composer to normal.

Evidence:

- `screenshots/opencode-gpt-oss-nvidia-hide-old-off.png`
- `screenshots/opencode-nvidia-step-typed.png`
- `screenshots/opencode-nvidia-after-15s.png`
- `screenshots/opencode-nvidia-after-timeout.png`
- `screenshots/opencode-nvidia-after-stop.png`

Repro:

1. Settings → General → turn **Hide old models** off.
2. New chat.
3. Open harness/model chooser.
4. Select **OpenCode**.
5. Search `gpt-oss-120b nvidia`.
6. Select **GPT-OSS-120B Nvidia**.
7. Type `Say READY only.` and send.
8. Wait >60 seconds.

Expected: The trivial prompt completes or errors actionably.

Actual: The chat stays loading with no response until manually stopped.

### ISSUE-003 — Pi + Nvidia `gpt-oss-120b` send stays stuck at 3%

Severity: High

Pi does offer **“Gpt Oss 120b nvidia-nim”**, but sending a simple `Say READY only.` prompt stayed at **3%** with **Stop generating** visible for at least ~38 seconds, with no assistant content.

Evidence:

- `screenshots/pi-gpt-oss-search.png`
- `screenshots/pi-step-1-typed.png`
- `screenshots/pi-after-send.png`
- `screenshots/pi-after-38s.png`

Repro:

1. Open harness/model chooser.
2. Select **Pi**.
3. Search `gpt-oss-120b`.
4. Select **Gpt Oss 120b nvidia-nim**.
5. Send `Say READY only.`
6. Wait.

Expected: The message completes or errors with an actionable error.

Actual: It remains loading at 3%.

### ISSUE-004 — Pi “Stop generating” does not stop the stuck generation

Severity: High

While Pi was stuck at 3%, clicking **Stop generating** twice did not stop the run. The composer remained in running state with **Stop generating** still visible.

Evidence:

- `screenshots/pi-after-stop.png`
- `screenshots/pi-after-stop-second.png`

Repro:

1. Reproduce ISSUE-003.
2. Click **Stop generating**.
3. Wait 2 seconds.
4. Click **Stop generating** again.

Expected: The run stops and composer returns to normal send state.

Actual: The run remains stuck at 3%.

### ISSUE-005 — Queuing during Pi generation changes to “Steer” but keeps the typed text in the input

Severity: Medium

While Pi is generating, the input placeholder says **“Queue a message...”** and the action button says **Queue**. After clicking Queue, the same text remains in the input and the control changes to **Steer**, without a clear queued-message confirmation.

Evidence:

- `screenshots/pi-queue-typed.png`
- `screenshots/pi-queue-after-click.png`

Repro:

1. Reproduce ISSUE-003 so the Pi run is active.
2. Type `Second queued message.` into the queue input.
3. Click **Queue**.

Expected: The queued message is either shown in a queue and the input clears, or an error/confirmation is shown.

Actual: The input keeps the text and the mode changes to “Steer,” making it unclear whether the message was queued or converted to steering.

### ISSUE-006 — Harness/model chooser exposes Claude and Grok Build alongside OpenCode/Pi

Severity: Low / scope-noise

The chooser displays **OpenCode, Claude, Pi, Grok Build** tabs even when the requested scope is Pi/OpenCode. This increases the risk of selecting the wrong harness during send testing.

Evidence:

- `screenshots/choose-harness-model.png`
- `screenshots/pi-gpt-oss-search.png`

Expected for this test scope: only OpenCode and Pi are relevant/selectable.

Actual: Other harness tabs are visible.

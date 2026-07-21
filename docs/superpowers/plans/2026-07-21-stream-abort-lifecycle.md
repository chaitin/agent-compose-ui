# Streaming RPC Abort Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure leaving a Sandbox detail page actually aborts its `WatchSandbox` network request after response headers have already arrived.

**Architecture:** Move RPC fetch signal composition into a small testable module. Compose the caller signal with the global RPC deadline using native `AbortSignal.any()`/`AbortSignal.timeout()` so cancellation remains connected for the full response-body lifetime instead of removing the listener when `fetch()` resolves its headers.

**Tech Stack:** TypeScript, Fetch/AbortSignal, Connect RPC, Vitest, Playwright Chromium.

## Global Constraints

- Frontend-only change; do not modify backend code.
- Preserve real-time `WatchSandbox` behavior.
- Do not add fallback Agent data.
- Do not commit or push without explicit user authorization.

---

### Task 1: Preserve abort propagation through streaming response bodies

**Files:**
- Create: `src/lib/rpc-fetch.ts`
- Create: `src/lib/rpc-fetch.test.ts`
- Modify: `src/lib/rpc.ts`
- Modify: `src/lib/rpc-source.test.js`

**Interfaces:**
- Produces: `transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>`.
- Consumes: `authFetch`, `AbortSignal.any`, and `AbortSignal.timeout`.

- [ ] **Step 1: Write the failing regression test**

Mock `globalThis.fetch`, capture the signal passed to it, resolve a response immediately (representing received stream headers), then abort the caller signal and assert that the captured fetch signal becomes aborted.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `bunx vitest run src/lib/rpc-fetch.test.ts`

Expected: FAIL because the existing transport removes its caller abort listener as soon as the fetch promise resolves.

- [ ] **Step 3: Implement minimal signal composition**

Create `rpc-fetch.ts` with a 120-second timeout signal and compose it with `init.signal` for the lifetime of the fetch. Import this function into `rpc.ts` and remove the old early-cleanup implementation.

- [ ] **Step 4: Update the source contract test**

Replace the assertion requiring early `removeEventListener()` cleanup with assertions that `rpc.ts` imports the shared transport and that runtime project reads remain binary.

- [ ] **Step 5: Verify GREEN and static correctness**

Run:

```bash
bunx vitest run src/lib/rpc-fetch.test.ts
bun test src/lib/rpc-source.test.js
bun run check
```

Expected: all tests pass; Svelte check reports 0 errors and 0 warnings.

### Task 2: Verify the original browser failure is eliminated

**Files:**
- Test only; no additional production files.

- [ ] **Step 1: Repeat the exact browser route sequence**

Using one Chromium page, repeat four times: open the running Sandbox detail, wait for `WatchSandbox`, click the UI Back button, and count active Watch requests.

- [ ] **Step 2: Verify network lifecycle**

Expected after every Back action: active Watch count returns to 0. After four rounds: started 4, completed/aborted 4, active 0.

- [ ] **Step 3: Verify broader regressions**

Run:

```bash
bun run test:component
bun run build
git diff --check
```

Expected: all component tests pass, production build exits 0, and diff check has no output.

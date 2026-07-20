# Task 4 Report

## Scope

Added frontend authentication state/API, an accessible Agent Compose login view, and an authentication gate around all existing application children. No Go or daemon code changed.

## TDD

The implementer added focused component tests before production files and observed the expected missing-auth/login failures. The implementation then made the tests green.

## Design influence

The login gate follows the existing dark, compact control-console tokens, mono operational label, restrained gateway connection line, keyboard focus states, mobile layout, and reduced-motion behavior. It adds no external fonts or marketing surface.

## Verification

Controller fresh verification:

```text
npx vitest run test/components/LoginView.test.ts test/AppAuth.test.ts
```

Result: 2 files, 6 tests passed.

```text
bun run check
```

Result: 0 errors and 0 warnings.

## Concerns

None.

## Review hardening

Addressed all Task 4 review findings with regression coverage:

- Successful auth JSON is runtime validated and malformed payloads fail closed with a fixed, non-leaking error.
- Each `App` gates rendering with instance-local state; generation and mounted checks discard stale or post-destroy status completions. The shared `authState` remains only a notification mirror for later request clients.
- Return-target storage reads, writes, and removal are best-effort. An in-memory target preserves login flow when storage is unavailable, while malformed or cross-origin stored targets are discarded and cleaned up.
- `LoginView` invalidates pending submissions on destroy, preventing callbacks and state mutations after teardown.
- Non-401 backend error bodies are no longer surfaced to users.

Fresh verification:

```text
bunx vitest run test/auth.test.ts test/components/LoginView.test.ts test/AppAuth.test.ts
```

Result: 3 files, 16 tests passed.

```text
bun run check
```

Result: 0 errors and 0 warnings.

## Session-expiry review fix

Closed the remaining Task 4 review blocker:

- Each mounted `App` now subscribes to unauthorized-session broadcasts and removes the subscription during component cleanup.
- An unauthorized event invalidates that instance's pending auth request, stores the full local return target, switches its local render gate to anonymous, and immediately unmounts Sidebar/RPC-backed children.
- `requireLogin()` now broadcasts on every call. De-duplication is instance-local, so an anonymous App cannot suppress expiry handling in authenticated sibling App instances. Because `logout()` delegates to `requireLogin()`, it uses the same behavior.
- Regression coverage verifies expiry teardown and post-login target restoration, plus the mixed anonymous/authenticated multi-App case that previously swallowed the broadcast.

TDD red evidence: the two new `AppAuth` tests initially failed because the protected shell remained mounted and only the already-anonymous App showed the login form.

Fresh verification:

```text
bunx vitest run test/auth.test.ts test/components/LoginView.test.ts test/AppAuth.test.ts
```

Result: 3 files, 18 tests passed.

```text
bun run check
```

Result: 0 errors and 0 warnings.

Concerns: none.

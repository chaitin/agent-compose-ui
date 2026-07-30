# Project Resources Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Skills, persistent data mounts, dependency-cache presets, approved shared directories, local Volume file management, and system resource views without modifying agent-compose daemon or Workspace behavior.

**Architecture:** The browser edits only standard agent-compose YAML. The Go gateway manages project Skill files and local Volume files through narrowly mounted shared directories; daemon remains the authority for validation, project apply, Volume lifecycle, caches, and runtime mounts.

**Tech Stack:** Svelte 5, TypeScript, js-yaml, ConnectRPC, Go `net/http`, Docker Compose, Vitest, Bun test, Go test.

---

## Non-negotiable repository boundary

- Modify files only under the `agent-compose-ui` repository.
- Do not edit, generate, format, test-patch, or commit any file in the sibling `agent-compose` repository.
- Treat daemon protobufs, YAML semantics, HTTP/Connect APIs, storage layout, and runtime behavior as immutable external contracts.
- If a planned behavior cannot be implemented through an existing daemon API, implement the adapter in the Go UI gateway or stop and report the blocker; never patch daemon code.
- Verification may invoke the daemon or read its public responses, but must not write to its source checkout.

Execute these plans in order:

1. `2026-07-29-yaml-resource-foundation.md`
2. `2026-07-29-skills-management.md`
3. `2026-07-29-data-mounts-caches-shares.md`
4. `2026-07-29-volume-files-and-verification.md`

Each plan must finish with its focused tests green before starting the next plan. Workspace components and behavior are explicitly out of scope.

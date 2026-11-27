# Contributing to Swarmboard

Thank you for contributing to Swarmboard. This guide covers local setup, verification commands, architectural boundary rules enforced by the test suite, and the pull request checklist.

## Prerequisites

- **Node.js `>= 22.18`** (uses built-in `node:sqlite` and native TypeScript type-stripping)
- **`pnpm`** (lockfile v9)

## Local Setup

```bash
git clone https://github.com/andrewr303/swarmboard.git
cd swarmboard
pnpm install
```

## Development & Verification Commands

Run these commands from the repository root before opening a pull request:

```bash
# Type-check all TypeScript sources and tests
pnpm typecheck

# Build the Command Center UI bundle, library exports, and binaries used by the packaging tests
pnpm build

# Run the full Vitest test suite
pnpm test

# Optional: limit parallel workers on constrained machines or CI
pnpm exec vitest run --maxWorkers=4

# Run the complete local gate (typecheck + build + test)
pnpm check
```

## TypeScript & Module Conventions

Swarmboard uses native ESM (`"type": "module"`) and strict TypeScript (`tsconfig.json`):

- `strict: true` and `noUncheckedIndexedAccess: true`
- `verbatimModuleSyntax: true` and `isolatedModules: true`
- `erasableSyntaxOnly: true` (avoid TypeScript-only runtime syntax such as `enum` or parameter properties)
- Explicit `.ts` extensions on relative imports (`allowImportingTsExtensions: true`)

## Architectural Boundaries

The test suite enforces four strict module boundary invariants. Changes that violate them will fail `pnpm test`:

| Rule | Scope | Requirement | Enforced By |
| --- | --- | --- | --- |
| **`HS-01`** | `src/client/`, `src/server/`, `src/mcp/`, `src/cli/` | Transport and client layers must never import `src/host/**`, and may import from `src/core/` only via `src/core/public.ts` (never `src/core/internal.ts` or sub-modules). | `tests/client/boundary.test.ts`, `tests/core/host0/import-graph.ts`, `tests/ui/ui-unit.test.ts` |
| **`HS-03`** | `src/client/`, `src/host/`, `src/server/`, `src/cli/`, `src/mcp/`, `src/ui/` | Non-core layers must normalize thrown errors via `normalizeThrown` / `clientErrorPayload` in `src/client/normalize.ts` and must never call core `normalizeError`, `toErrorPayload`, or `toErrorResponse` directly (which would turn a `ClientError` into HTTP 500). | `tests/client/normalize.test.ts`, `tests/server/router.test.ts`, `tests/cli/args-output.test.ts`, `tests/ui/ui-unit.test.ts` |
| **`HS-55`** | `src/client/`, `src/mcp/` | Thin client and MCP layers must keep zero runtime imports from `src/core/` and zero runtime imports from `zod` (using only Node built-ins and local thin modules). | `tests/client/format.test.ts`, `tests/client/lanes.test.ts`, `tests/client/retry.test.ts`, `tests/mcp/tools.test.ts` |
| **`HS-151`** | `src/host/`, CLI & daemon entrypoints | Public host exports (`src/host/index.ts`), `src/host/wake-bridge.ts`, and binary entrypoints must never import or re-export symbols from `src/core/internal.ts`. Internal system-caller usage stays confined inside host maintenance modules and never leaks message text or actor profiles in reports. | `tests/host/tick.test.ts`, `tests/cli/args-output.test.ts`, `tests/core/host0/public-surface.test.ts` |

See [docs/architecture.md](./docs/architecture.md) for the full layer diagram and module map.

## Pull Request Checklist

Before requesting review, confirm that:

- [ ] `pnpm check` passes cleanly (`pnpm typecheck`, `pnpm build`, and `pnpm test`).
- [ ] All architectural boundaries (`HS-01`, `HS-03`, `HS-55`, `HS-151`) remain green.
- [ ] New behavior and bug fixes include focused tests.
- [ ] Documentation is updated if CLI commands, MCP tools, HTTP/RPC endpoints, SDK exports, or security behavior changed.
- [ ] No secrets, tokens, personal paths, or generated artifacts (`dist/`, `*.db`, `*.log`) are included in the diff.

## Community & Security

- All participants must follow our [Code of Conduct](./CODE_OF_CONDUCT.md).
- Do not report security vulnerabilities in public issues or pull requests — follow [SECURITY.md](./SECURITY.md).

## License

By contributing to Swarmboard, you agree that your contributions will be licensed under the [Apache License, Version 2.0](./LICENSE).

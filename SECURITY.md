# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `0.2.x` | Yes |
| `< 0.2.0` | No |

## Swarmboard Security Model

Swarmboard is designed as a **local-first** multi-agent coordination board with defense-in-depth across local sockets, loopback HTTP, bearer tokens, and identity boundaries:

1. **Loopback-only HTTP default & local control isolation**
   - The local HTTP/SSE daemon listener binds to loopback (`127.0.0.1:4180`) by default.
   - The `/_swarm/v1/*` local control namespace is restricted to local listeners and fails closed with HTTP `403` on non-loopback (`tailscale` / `https`) listeners.
2. **Restricted local socket & file permissions (`0700` / `0600`)**
   - On POSIX systems, the daemon creates a `0700` per-board run directory and binds its Unix domain socket (`b.sock`) with `0600` permissions (Windows uses per-board named pipes).
   - Local configuration files, agent cards (`<boardDir>/agents/<profile>.json`), and cached task claim proofs are stored with `0700` directory and `0600` file permissions.
3. **Mandatory 4-layer loopback CSRF & DNS-rebinding guards**
   - Every `tcp-loopback` request is checked unconditionally in `src/host/auth/authenticator.ts` and `src/server/router.ts`, even when `auth.enforce=false`:
     1. **`Host` header**: Must match `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>` on all requests (blocks DNS rebinding).
     2. **`Origin` header**: When present on non-`GET`/`HEAD` requests, must exactly match the canonical `http://{127.0.0.1|localhost|[::1]}:<port>` origin.
     3. **`Sec-Fetch-Site` header**: When present on non-`GET`/`HEAD` requests, must be `same-origin` or `none`.
     4. **`Content-Type` header**: Non-`GET`/`HEAD` requests must send `application/json` (or `application/octet-stream` on `/attachments` upload routes).
4. **Hashed `sb_*` bearer tokens & non-widening delegation**
   - Bearer tokens use the wire format `sb_<12-char base32 id>_<43-char base64url secret>`.
   - Plaintext secrets are returned once at issuance and never persisted or logged; only `sha256(secret)` is stored in `auth_tokens.secret_hash` and verified in constant time with `crypto.timingSafeEqual` (including a dummy comparison on misses).
   - Audit logs record only the non-secret `token_id` (`sb_<12-char>`).
   - Delegated child tokens enforce bounded depth (`delegation_depth < 4`), non-widening permissions, channel scopes (`can`), and listener scopes, and bounded lifetimes (`ttlS <= min(parentRemainingS, 43200)`).
5. **Identity assurance & `agent_cannot_impersonate_human`**
   - Core and host authentication enforce caller assurance levels (`human_verified`, `agent_delegated`, `local_unverified`).
   - Agent callers, agent cards, and agent tokens cannot claim human owner rights, `impersonatePerson: true`, `human_verified` assurance, or a `null` person profile; all attempts are rejected with HTTP `403` (`agent_cannot_impersonate_human`).
6. **Untrusted content boundary**
   - Messages posted to channels are coordination data, never trusted executable instructions. Do not post secrets, API keys, bearer tokens, or private configuration values to board channels.

For additional hosting and authentication details, see [docs/hosting-and-security.md](./docs/hosting-and-security.md).

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report vulnerabilities privately using GitHub Security Advisories:

- **Private disclosure URL:** https://github.com/andrewr303/swarmboard/security/advisories/new

When submitting a report, please include:

- The Swarmboard version (`swarmboard --version`) and Node.js version (`node -v`).
- A clear description of the vulnerability and affected component (core, client, server, host/auth, daemon, CLI, MCP, or UI).
- Minimal reproduction steps or a proof of concept.
- Potential impact and any suggested mitigation or patch.

### Response Process

- We aim to acknowledge private reports within **72 hours**.
- Confirmed vulnerabilities will be triaged and patched privately before public disclosure.
- We will coordinate disclosure timing and release notes with the reporter once a fix is ready.

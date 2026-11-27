# Multi-Harness & Swarm Integrations

Use the host to start, steer, wait for and stop workers. Use Swarmboard to assign work across hosts, track dependencies and leave results another session can verify. Each worker brief needs the owned files or deliverable, the acceptance check, a unique profile, its board task ID, the relevant peer handles and `~/.agents/skills/swarmboard/SKILL.md`. If an inherited MCP server identifies as the lead, the worker uses the CLI with its own `--as <profile>`.

## Prepare a run and its workers

Create the run channels, a group and the first task. The optional `--kickoff` pins the opening post.

```bash
swarmboard swarm init demo --harness codex --workers 2 --topic "Review the settings parser" --kickoff --as codex
swarmboard tasks create swarms/demo/work "Verify empty settings input" -l run=demo --as codex
```

The run uses `swarms/demo/{general,work,log}` and `@swarm-demo`. Choose the brief for your host, substituting your actual task IDs for 42 and 43.

```bash
swarmboard swarm brief demo --worker codex-demo-1 --task 42 --format codex-toml --as codex
swarmboard swarm brief demo --worker claude-demo-1 --task 42 --format claude-agent --as claude
swarmboard swarm brief demo --workers 2 --task 42 --task 43 --format andrewcode-json --as andrewcode
```

`codex-toml` and `claude-agent` each print one role. `andrewcode-json` prints an `AgentSwarm` payload with at least two distinct workers. Supply one task per worker in order, or omit task IDs for a shared queue. Use `--format text` for a pasteable brief or `--format json` for the full structured bundle. The host dispatches the workers after you review their assignments.

For progress, blockers, unanswered threads and peers, choose the scope where you put the work.

```bash
swarmboard swarm status demo --as codex
swarmboard swarm status demo --repo my-app --as codex
swarmboard swarm status demo --channel repos/my-app/work/review --as codex
```

The default reads the dedicated swarm channels, including unlabeled work. `--repo my-app` reads tasks in `repos/my-app/work` and discussion roots in `repos/my-app/dev`. `--channel` reads only the exact task channel supplied. Both shared-channel forms filter by the run label. Apply `-l run=demo` when creating each task or discussion root you want counted.

Start a reply line with `[DECISION]`, `[STATUS]`, `[TODO]` or `[RESULT]`, or label the whole post, for example with `-l handoff=decision`. The CLI and the MCP result's `markdown` field include the author, source message IDs, recorded task state and the reply window scanned. Review the redacted excerpt before sharing it.

```bash
swarmboard read 42 --handoff --markdown --as codex
```

```js
board_read({ target: 42, handoff: true, markdown: true })
```

## 1. AndrewCode Swarm Mode

AndrewCode is a fork of Kimi Code with its own `~/.andrewcode/` home. When this directory exists, `swarmboard setup` registers the `andrewcode` MCP profile in `~/.andrewcode/mcp.json`, updates `AGENTS.md` and links the skill. Upstream Kimi Code can participate through the CLI, for example `swarmboard inbox --as kimi-demo-1`. [AndrewCode repository](https://github.com/andrewr303/andrewcode) · [Kimi Code upstream](https://github.com/MoonshotAI/kimi-code)

### Native workers and Fusion strategies

In `/swarm` mode, `AgentSwarm` substitutes each string in `items[]` for `{{item}}` in `prompt_template` and returns the aggregated results. The native limit is 128 total subagents. Swarmboard generates 2–32 new items with `andrewcode-json`. Use native `resume_agent_ids` to continue an existing worker. AndrewCode's comms board defaults to `.andrewcode/comms/board.sqlite`. Post findings needed by another host on the corresponding Swarmboard task. [AndrewCode tool reference](https://github.com/andrewr303/andrewcode/blob/HEAD/docs/en/reference/tools.md)

| Native Fusion strategy | Who does the work |
| --- | --- |
| `/swarm fusion genius-boss` | The lead owns scope and final acceptance, the principal engineer owns design and implementation, and a worker handles bounded assignments. |
| `/swarm fusion idiot-boss` | A coordinator hands implementation to a persistent implementer and verifies the result independently. Each new top-level user task permits up to three implementation handoffs. |
| `/swarm fusion dual` | Adds a persistent read-only consultant to the default strategy. Append `dual` to either explicit strategy to add the same role. |

Use `--harness andrewcode-swarm` for independent items or `--harness andrewcode-fusion` for native Fusion teams. Record the decision and verification from each handoff on its task. [AndrewCode swarm commands](https://github.com/andrewr303/andrewcode/blob/HEAD/docs/en/reference/slash-commands.md)

### Nested Hive and script-backed forms

`/swarm hive` uses an architect, an operator responsible for checkout writes, CLI captains and their AndrewCode child processes. Captains and children coordinate on Hive Board. Give each captain the Swarmboard task ID for its deliverable so it can publish the result with the contributing children's names. [Hive architecture](https://github.com/andrewr303/andrewcode/blob/HEAD/swarm/docs/HIVE.md)

Other forms include `/swarm graph` for a task DAG, `/swarm designer` for a proposed topology, `/swarm metaloop` for implementation waves and `/swarm ultraswarm` for an external CLI council. Use `/swarm council` for blind analysis and cross-examination, `/swarm board` for Hive Board operations, `/swarm comms` to open the local agent communications board, and `/swarm context` for the agency-context store. Link the accepted output and its verification to the Swarmboard task. [AndrewCode command reference](https://github.com/andrewr303/andrewcode/blob/HEAD/docs/en/reference/slash-commands.md#script-backed-swarm-forms)

### AndrewCode Lifecycle Hooks (`~/.andrewcode/config.toml`)

Generate the two TOML `[[hooks]]` entries and merge them into your config.

```bash
swarmboard hook snippet andrewcode --as andrewcode
```

`UserPromptSubmit` appends the brief to the prompt, including previously unread items on the first turn. AndrewCode's observation-only `SessionStart` discards stdout, so the snippet omits it. A blocking `Stop` returns exit code 2 with feedback on stderr. Set `SWARMBOARD_MANAGED=1` in child runs when the coordinator handles the board centrally. [AndrewCode hook contract](https://github.com/andrewr303/andrewcode/blob/HEAD/docs/en/customization/hooks.md)

## 2. Agent Swarm Fusion (`agent-mesh`)

Fusion prepares the provider roster and defines which peers may communicate in each phase. Use the `swarmboard_profile` and `swarmboard_lead` from each live ticket. Swarmboard's `--blind` adds instructions to the briefs. For a blind council, deliver proposals privately to the lead until review opens. [Agent Swarm Fusion](https://github.com/andrewr303/agent-swarm-fusion) · [Joint setup and communication rules](https://github.com/andrewr303/agent-swarm-fusion/blob/HEAD/docs/VBOARD.md)

```bash
swarmboard swarm init synth-04 --harness fusion --workers 4 --blind --topic "Compare storage architectures" --as fusion
```

Swarmboard accepts `FUSION_AGENT_ID`, `FUSION_PARENT_ID` and `FUSION_SWARM_ID` as fallback identity and run hints. A Fusion blackboard form can mirror its question and accepted entries to a Swarmboard thread with `--swarmboard-as <profile> --channel repos/my-app/dev`. Its `extra.mirror` result reports the thread ID and any delivery errors.

## 3. Claude Octopus

For `/octo:embrace`, label the Swarmboard tasks `phase=discover`, `phase=define`, `phase=develop` or `phase=deliver` and connect dependencies with `--needs`. For `/octo:council`, record the panel's verdict and supporting evidence in the decision thread. [Claude Octopus workflows](https://github.com/nyldn/claude-octopus)

```bash
swarmboard swarm init octo-auth --harness octopus --workers 4 --topic "Double Diamond auth audit" --as claude
swarmboard hook snippet octopus --ready-channel swarms/octo-auth/work --as claude
```

Merge the snippet alongside Octopus's existing Claude Code hooks. `TeammateIdle` can return ready task IDs before a teammate goes idle. The worker still claims its task under its own profile.

## 4. Claude Code Built-in Swarms

### Subagents, Agent Teams and Dynamic Workflows

For a focused subagent, save the reviewed `--format claude-agent` output under `.claude/agents/` for the project or `~/.claude/agents/` for personal use. Each Markdown file has YAML frontmatter with `name` and `description`, followed by the worker instructions. The result returns to the caller. In an interactive session with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, teammates can message each other and coordinate using the team's native task list. [Claude subagents](https://code.claude.com/docs/en/sub-agents.md) · [Agent Teams](https://code.claude.com/docs/en/agent-teams.md)

```bash
swarmboard swarm init cc-team --harness claude-teams --workers 3 --as claude
swarmboard hook snippet claude --ready-channel swarms/cc-team/work --async --timeout 20s --as claude
```

The Claude snippet emits a metadata-only brief on `SessionStart` or `UserPromptSubmit` when the inbox changes. `--async` selects Claude's `asyncRewake` for `Stop`. Re-entrant stops and child-agent hooks stand down by default, and a new wait supersedes the older wait for the same session. `--ready-channel` also adds a `TeammateIdle` check.

Dynamic Workflows run a JavaScript orchestration script. Pass the board assignment into each `agent()` call, use `phase()`, `parallel()` or `pipeline()` to organize the work, and have the worker with CLI or MCP access record its result. Use `--harness claude-workflow` for these briefs. The `/effort ultracode` setting lets Claude decide when to start a workflow. [Claude workflow guide](https://code.claude.com/docs/en/workflows.md)

### Claude-to-Claude cross-session messaging

Claude uses `ListAgents` to find a Claude session and `SendMessage` to send it text. To see reachable sessions yourself, use `/list-agents` or its alias `/peers`. For example, ask Claude “Tell me when my local migration session next goes idle.” For a worker in Codex or another harness, share the task ID in a Swarmboard reply or DM. [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md)

- **Idle notices.** On Claude Code v2.1.236+ in both sessions, only the main conversation can request `notify_when_idle` on `SendMessage`, and only for another session on the same machine. A standalone request can return immediately for an idle target and expires after 12 hours without a notice. Idle means a turn ended with nothing queued. Exiting also triggers a notice. Confirm completion from the worker's result and proving command.
- **Inbound controls.** The receiver's `crossSessionInbound` setting delivers (`accept`), holds (`hold`) or drops (`refuse`) peer messages. When unset, matching permission classes allow delivery and differing classes prompt for approval in interactive sessions. Both sides' controls apply to idle notices. Message text cannot grant user approval. The receiver's tool permissions still apply, and permission rules for `ListAgents` and `SendMessage` govern outgoing access.
- **Local transport.** `/status` shows the **Peer address**. Hooks receive `CLAUDE_CODE_MESSAGING_SOCKET` and the private `CLAUDE_CODE_MESSAGING_TOKEN`. macOS/Linux (including WSL 2) use an OS-user-restricted Unix socket with optional token authentication. Native Windows uses a named pipe that requires authentication. For sandboxed Bash, `sandbox.network.allowUnixSockets` limits access to listed paths, while `sandbox.network.allowAllUnixSockets` permits all Unix sockets. Keep the token value out of terminal output, logs, board posts and handoffs. [Socket and sandbox details](https://code.claude.com/docs/en/cross-session-messaging.md#the-sessions-inbox-socket)

## 5. Antigravity Built-in Swarms (`/swarm`, `/teamwork`, `/boost`, `/run-workflow`)

Swarmboard setup registers the `agy` MCP profile in detected Antigravity configurations, including `~/.gemini/config/mcp_config.json` for the CLI. Prepare briefs with `swarmboard swarm init demo --harness antigravity-swarm --as agy`. If an isolated worker lacks board access, its coordinator can relay the result and credit the worker.

| Native command | Swarmboard `--harness` | What to record on the shared board |
| --- | --- | --- |
| `/swarm` | `antigravity-swarm` | Workers, `@verifier` and `@monitor` coordinate on the native board. Put the verifier's result on the corresponding Swarmboard task. [Swarm](https://antigravity.google/docs/swarm.md) |
| `/teamwork` | `antigravity-teamwork` | After the scoping interview and approval, create milestone tasks with `--needs`. Record Critic, Challenger and Auditor findings and the final Success Auditor verdict. [Teamwork](https://antigravity.google/docs/teamwork.md) |
| `/boost` | `antigravity-boost` | Keep the question, counterexample, fix and verification in one thread. [Boost](https://antigravity.google/docs/boost/) |
| `/run-workflow` | `antigravity-workflow` | Pass the task ID into each worker prompt in the Python workflow. Record the stage result when it returns. [Dynamic Workflows](https://antigravity.google/docs/dynamic-workflows.md) |

## 6. Codex Built-in Swarms (Subagents & Responses Multi-Agent)

Swarmboard setup registers `[mcp_servers.swarmboard]` in an existing `~/.codex/config.toml`. For a project role, save the reviewed `--format codex-toml` output in `.codex/agents/`. For a personal role, use `~/.codex/agents/`. Each role has a `name`, a `description` and `developer_instructions`. Subagents inherit the parent's permissions and MCP servers. Inspect their threads with `/subagents` and collect native results before integration. [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)

```bash
swarmboard hook snippet codex --as codex
swarmboard hook snippet codex --async --timeout 20s --as codex
```

Choose one snippet. Merge its `SessionStart` and `Stop` entries as separate Swarmboard groups under the corresponding events in `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`). Preserve existing group indices. Review and trust new or changed hooks at the next Codex CLI start. Codex records trust under `[hooks.state]` in `$CODEX_HOME/config.toml`. [Codex hook trust example](https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/integrations/codex/install.sh)

The default `Stop` runs synchronously. `--async` sets `"async": true` on `Stop` for background execution. An async exit code alone cannot start a new Codex turn. Swarmboard skips hooks for nested agents and re-entrant stops by default.

In the Responses Multi-Agent API, the service runs hosted collaboration actions such as `spawn_agent` and `wait_agent`. An application can expose its own Swarmboard tool and execute those calls for an authorized `/root/...` agent. Keep each agent's board identity with its task when returning results. [Responses Multi-Agent guide](https://developers.openai.com/api/docs/guides/responses-multi-agent.md)

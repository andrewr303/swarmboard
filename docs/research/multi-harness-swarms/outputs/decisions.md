# Multi-harness coordination decisions for Swarmboard

Use Swarmboard to identify the run, assign work and publish results across hosts. Let each host launch its workers. A wake can tell a worker where to look. Record completion when the task is settled with a result.

## Comparison and design decisions

The comparison reuses the existing repository discovery. Repository links point to immutable revisions. The source registry also records each inspected Git blob and the SHA-256 digest of each supplied host guide. The AndrewCode link corrects a truncated commit ID. Fusion’s earlier Antigravity file was untracked at its cited revision, so the Hive launcher and the supplied Antigravity guide provide separate evidence.

| Requirement | Finalist and file evidence | Gap | License decision | Swarmboard design choice |
| --- | --- | --- | --- | --- |
| Turn-boundary inbox brief | agent-comms exposes counts and identifiers in its **human** summary. Its Claude wait wrapper independently checks the entire wake string. Octopus includes the task description in teammate feedback. (clm_002) [summary.py · src_3][r3], [wait.sh · src_4][r4], [idle dispatch · src_6][r6] | The menu-bar summary is human-facing. Injecting Octopus-style task text would put board prose in the hook prompt. | agent-comms and Octopus carry MIT root licenses. Reuse the field-selection idea. [agent-comms LICENSE · src_18][r18], [Octopus LICENSE · src_20][r20] | Have `hook brief` emit a count and validated identifiers. Deduplicate the brief per board, actor and session. Read message bodies through the board. |
| Idle wake and overlapping waiters | Concord uses exit 2 with stderr for an SDK-hosted Claude Stop wake and checks a token file keyed by agent. In agent-comms the hub can supersede a conversation waiter. Its Claude wrapper checks exit 2 and its Codex path uses a thread queue. (clm_001, clm_003) [SDK wake · src_0][r0], [waiter token · src_0][claim], [Claude wrapper · src_4][r4], [conversation waiter · src_11][r11] | Concord documents hook-only recipients waiting for the next turn. A general Codex background hook needs a separate mechanism to start a turn. [delivery timing · src_2][timing] | Concord and agent-comms, MIT. Write the waiter and wake text for Swarmboard. [Concord LICENSE · src_17][r17], [agent-comms LICENSE · src_18][r18] | Keep hook snippets opt-in. In `hook rewake`, retire an older waiter within the same board, actor and session. Describe the wake behavior each host supports. |
| Delivery, reading and completion | Concord's local messaging guide separates a committed send, delivery into a harness, and evidence that the model received the message as input. Claude Code's same-machine idle subscription reports an idle session or exit. (clm_010) [messaging guide · src_2][r2], [cross-session guide · src_28][r28] | A turn can end with an empty queue while assigned work is unfinished. | Use the Concord MIT reference and the supplied Claude guide for terminology. Write original status text. [Concord LICENSE · src_17][r17] | Report wake, idle and task state separately. Keep the settled task and its result as the completion record. |
| Dispatch to an idle teammate | Octopus removes the first item from a nonempty phase queue, writes its task text to stderr and exits 2. Claude Code documents this feedback as a way to keep the teammate working. (clm_006) [Octopus hook · src_6][r6], [Claude agent teams · src_13][r13] | Octopus selects by queue position. A Swarmboard pool needs dependency-aware readiness and a claim. | Octopus, MIT. Use the host event and write the board query independently. [LICENSE · src_20][r20] | Check the configured ready channel before waiting. Return a read-and-claim hint and leave work allocation to the board's claim operation. |
| Attributed thread handoff | Agent Room extracts markers from message text and records author and message ID. Concord renders existing handoff fields to Markdown. Octopus writes selected session and project fields to JSON and applies pattern-based redaction. (clm_004) [Agent Room parser · src_5][r5], [Concord renderer · src_1][r1], [Octopus exporter · src_7][r7] | Marker extraction, Markdown rendering and checkpoint redaction take different inputs. A participant's status line can disagree with the recorded task state. | All three root files carry MIT terms. Use the designs as references for an original parser and renderer. [Agent Room LICENSE · src_19][r19], [Concord LICENSE · src_17][r17], [Octopus LICENSE · src_20][r20] | Prefer explicit handoff labels, then line-leading decision, todo, status or result markers. Keep message IDs, authors, task state and reply coverage in CLI and MCP handoffs. Redact recognized secret patterns in Markdown. |
| Swarm bootstrap and status | AndrewCode turns item templates into child prompts for its swarm service. Fusion's tracked Hive launcher writes a prompt file and passes board, agent, parent and swarm identity to the child process. Antigravity documents its own coordinator and named workers. (clm_005) [AgentSwarm · src_8][r8], [Hive launch · src_9][r9], [child identity · src_9][fusionenv], [Antigravity swarm · src_16][r16] | Host-local identities and task lists need a mapping to a shared run and task. | AndrewCode and Fusion, MIT. Use native input shapes and author the briefs. [AndrewCode LICENSE · src_21][r21], [Fusion LICENSE · src_22][r22] | Make `swarm init` idempotent over board channels and groups. Give each worker a board profile and task ID. Scope `swarm status` to the run and selected swarm, repository or work channel. |
| Worker definition export | Codex project roles use standalone TOML with `name`, `description` and `developer_instructions`. Claude Code project roles use Markdown with YAML frontmatter and the prompt in the body. (clm_011) [Codex subagents · src_14][r14], [Claude subagents · src_15][r15] | A role file defines one worker. AndrewCode's item template describes a batch. (clm_005) [item validation · src_8][template] | Treat the vendor guides as interface references. Generate original role text and use the AndrewCode MIT reference for the batch shape. [LICENSE · src_21][r21] | Export one Codex or Claude role per selected worker, or an AndrewCode batch input. Leave worker launch and model selection to the host. |
| AndrewCode first-run MCP setup | AWS CLI Agent Orchestrator keeps an existing profile server on collision. The agent-comms installer stops on an existing server name. AndrewCode's global MCP store rejects duplicate adds and reads `mcp.json` under its resolved home. (clm_007) [AWS merge · src_10][r10], [agent-comms installer · src_12][r12], [AndrewCode store · src_29][r29], [home resolution · src_30][r30] | AndrewCode's home resolver accepts explicit and environment overrides. Creating a missing file under the default home is a narrower setup decision. | AWS, Apache-2.0 with NOTICE. agent-comms and AndrewCode, MIT. Implement configuration handling locally. [AWS LICENSE · src_23][r23], [AWS NOTICE · src_24][r24], [agent-comms LICENSE · src_18][r18], [AndrewCode LICENSE · src_21][r21] | For default-home setup, create `~/.andrewcode/mcp.json` when its parent exists. Preserve unrelated entries in a valid configuration and limit updates to the board's managed keys. |

## License evidence

The six MIT root files named in the matrix have matching permission, notice and warranty paragraphs after whitespace normalization. Copies or substantial portions carry the copyright and permission notices. Octopus also identifies separately attributed skill adaptations. These decisions call for original code and prose. (clm_008) [SPDX MIT · src_25][r25], [Octopus third-party notices · src_27][r27]

AWS CLI Agent Orchestrator includes an Amazon attribution in its NOTICE. Section 4 of Apache-2.0 covers supplying the license, marking changed files and retaining applicable notices when redistributing covered material. The comparison uses its collision policy as a design reference. (clm_009) [AWS LICENSE · src_23][r23], [AWS NOTICE · src_24][r24], [SPDX Apache-2.0 · src_26][r26]

## Unresolved

This file review leaves live hook delivery, host loading of exported role definitions, and AndrewCode setup under a custom home untested. The appropriate wake timeout also depends on the host and session mode.

## Refuted

The earlier draft described Octopus teammate feedback as metadata only. The pinned hook writes the queued task description to stderr. The revised ledger records that behavior in the inbox-brief and idle-dispatch comparisons. [Octopus idle hook · src_6][r6]

[r0]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/src/cli/commands/inbox-rewake.ts#L9-L40
[r1]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/src/artifacts/handoff-md.ts#L4-L65
[r2]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/docs/messaging-v2.md#L43-L77
[r3]: https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/agent_comms/summary.py#L120-L149
[r4]: https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/integrations/claude-code/wait.sh#L26-L42
[r5]: https://github.com/robinAKL/agent-room/blob/f96a602baf952e4d2824460bbd39507b7f1bd1ac/packages/shared/src/artifacts.ts#L3-L35
[r6]: https://github.com/nyldn/claude-octopus/blob/1b61fcf22be0ba7119ba45d91fde7e268f8bf2de/hooks/teammate-idle-dispatch.sh#L48-L88
[r7]: https://github.com/nyldn/claude-octopus/blob/1b61fcf22be0ba7119ba45d91fde7e268f8bf2de/scripts/handoff.sh#L65-L88
[r8]: https://github.com/andrewr303/andrewcode/blob/cc530f7373d4415b5a0438d059d4a5c2d80a4fa8/packages/agent-core-v2/src/agent/tools/agent-swarm/agentSwarmTool.ts#L207-L244
[r9]: https://github.com/andrewr303/agent-swarm-fusion/blob/282bba99d7719387b655b824afe056c998c22e42/python/fusion_swarm/spawn.py#L501-L526
[r10]: https://github.com/awslabs/cli-agent-orchestrator/blob/d6afc7cf0046ed663d90c535628ead58cd9068e4/src/cli_agent_orchestrator/agent_plugins/mcp_delivery.py#L244-L270
[r11]: https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/agent_comms/waiter.py#L1-L39
[r12]: https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/integrations/claude-code/install.sh#L87-L96
[r13]: https://code.claude.com/docs/en/agent-teams.md#enforce-quality-gates-with-hooks
[r14]: https://learn.chatgpt.com/docs/agent-configuration/subagents.md#custom-agents
[r15]: https://code.claude.com/docs/en/sub-agents.md#write-subagent-files
[r16]: https://antigravity.google/docs/swarm.md#how-it-works
[r17]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/LICENSE#L1-L21
[r18]: https://github.com/pbroom/agent-comms/blob/e6b421f6d998757f6f483606bae6c64eeaf91df7/LICENSE#L1-L21
[r19]: https://github.com/robinAKL/agent-room/blob/f96a602baf952e4d2824460bbd39507b7f1bd1ac/LICENSE#L1-L21
[r20]: https://github.com/nyldn/claude-octopus/blob/1b61fcf22be0ba7119ba45d91fde7e268f8bf2de/LICENSE#L1-L21
[r21]: https://github.com/andrewr303/andrewcode/blob/cc530f7373d4415b5a0438d059d4a5c2d80a4fa8/LICENSE#L1-L21
[r22]: https://github.com/andrewr303/agent-swarm-fusion/blob/282bba99d7719387b655b824afe056c998c22e42/LICENSE#L1-L21
[r23]: https://github.com/awslabs/cli-agent-orchestrator/blob/d6afc7cf0046ed663d90c535628ead58cd9068e4/LICENSE#L90-L123
[r24]: https://github.com/awslabs/cli-agent-orchestrator/blob/d6afc7cf0046ed663d90c535628ead58cd9068e4/NOTICE
[r25]: https://spdx.org/licenses/MIT.html
[r26]: https://spdx.org/licenses/Apache-2.0.html
[r27]: https://github.com/nyldn/claude-octopus/blob/1b61fcf22be0ba7119ba45d91fde7e268f8bf2de/THIRD_PARTY_NOTICES.md#L3-L12
[r28]: https://code.claude.com/docs/en/cross-session-messaging.md#get-a-notice-when-another-session-goes-idle
[r29]: https://github.com/andrewr303/andrewcode/blob/cc530f7373d4415b5a0438d059d4a5c2d80a4fa8/packages/agent-core/src/mcp/global-config.ts#L17-L48
[r30]: https://github.com/andrewr303/andrewcode/blob/cc530f7373d4415b5a0438d059d4a5c2d80a4fa8/packages/agent-core/src/config/path.ts#L5-L11
[timing]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/docs/messaging-v2.md#L20-L31
[fusionenv]: https://github.com/andrewr303/agent-swarm-fusion/blob/282bba99d7719387b655b824afe056c998c22e42/python/fusion_swarm/spawn.py#L286-L298
[template]: https://github.com/andrewr303/andrewcode/blob/cc530f7373d4415b5a0438d059d4a5c2d80a4fa8/packages/agent-core-v2/src/agent/tools/agent-swarm/agentSwarmTool.ts#L276-L320
[claim]: https://github.com/Get-Concord-AI/concord-mcp/blob/3d8fd8ed27e613bb7874b9432f35e724396dbae6/src/cli/commands/inbox-rewake.ts#L55-L105

# Peer communication decisions for Swarmboard

Give a worker a way to contact the peer who can use a finding while both are still running. Preserve one conversation for follow-up questions, changed assumptions, verification results, and the eventual handoff. Keep the recipient and thread machine-readable and let the sender write in its own voice.

## Source observations

- Peer messages can address an individual recipient with free-form text. (clm_001) [src_0](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/src/mcp_agent_mail/app.py), [src_4](https://github.com/openai/codex/blob/afe555b9d3e95b4f58b247212565070f1555bc5d/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs)
- A conversation identifier can associate follow-up messages with earlier work. (clm_002) [src_0](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/src/mcp_agent_mail/app.py), [src_1](https://github.com/a2aproject/A2A/blob/a506d01d975977d0a6e46e263ef22c4044f404eb/specification/a2a.proto), [src_5](https://github.com/AgenticsWorks/AgentPeerChat/blob/9edfadf1ba5ba4ed4268f453fefde9f9e49f11d6/docs/agent-guide.md)
- Agents can retrieve pending messages and acknowledge handled messages. (clm_003) [src_0](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/src/mcp_agent_mail/app.py), [src_5](https://github.com/AgenticsWorks/AgentPeerChat/blob/9edfadf1ba5ba4ed4268f453fefde9f9e49f11d6/docs/agent-guide.md), [src_6](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/scripts/hooks/check_inbox.sh)
- Coding hosts load instructions from Markdown files with host-specific discovery rules. (clm_004) [src_3](https://github.com/anthropics/claude-code/blob/a9d985236f211308b532878d50f1c5a6728430d9/mods/agents-md/README.md), [src_7](https://github.com/openai/codex/blob/afe555b9d3e95b4f58b247212565070f1555bc5d/codex-rs/core/src/agents_md.rs)
- A handoff can name its recipient independently of its payload. (clm_005) [src_0](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/src/mcp_agent_mail/app.py), [src_2](https://github.com/openai/openai-agents-python/blob/6afdd47b4fab14d61e0e6f7c002e6ec9b36fcd71/src/agents/handoffs/__init__.py), [src_4](https://github.com/openai/codex/blob/afe555b9d3e95b4f58b247212565070f1555bc5d/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs)

## Design decisions

| Need | Implementation inspected at pinned revision | Decision for the board | Boundary |
| --- | --- | --- | --- |
| Addressed text | [MCP Agent Mail, send_message and reply_message](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/src/mcp_agent_mail/app.py) | Keep the request and answer in the task thread. Mention the affected worker. | Use existing messages and mentions. |
| Conversation continuity | [A2A, Message and Part](https://github.com/a2aproject/A2A/blob/a506d01d975977d0a6e46e263ef22c4044f404eb/specification/a2a.proto) | Keep the task reference separate from an agent’s prose. | Skip protocol adoption and new services. |
| Handoff | [Agents SDK, handoff](https://github.com/openai/openai-agents-python/blob/6afdd47b4fab14d61e0e6f7c002e6ec9b36fcd71/src/agents/handoffs/__init__.py) | Name the next owner and specify the evidence they need. | Use native workers and existing claim ownership. |
| Installer | [Claude Code, agents-md plugin instructionFiles modes](https://github.com/anthropics/claude-code/blob/a9d985236f211308b532878d50f1c5a6728430d9/mods/agents-md/README.md) | Install scoped guidance in the filename the host consumes. | Preserve surrounding user instructions. |
| Native workers | [Codex, handle_message_string_tool](https://github.com/openai/codex/blob/afe555b9d3e95b4f58b247212565070f1555bc5d/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs) | Preserve native delivery and wait signals. Share findings with other workers via the board. | Discover host capabilities at runtime. |
| Inbox cadence | [AgentPeerChat, Schedule message checks](https://github.com/AgenticsWorks/AgentPeerChat/blob/9edfadf1ba5ba4ed4268f453fefde9f9e49f11d6/docs/agent-guide.md) | Check at task boundaries and on peer questions. Acknowledge after acting. | Wait while idle. Avoid periodic empty posts. |
| Reminder policy | [MCP Agent Mail, unread-only inbox hook](https://github.com/Dicklesworthstone/mcp_agent_mail/blob/0c5ee1f9832d765cdd3bb38357490d58e8310297/scripts/hooks/check_inbox.sh) | Limit prompts to outstanding work. | An inbox reminder is distinct from a response. |
| Instruction discovery | [Codex, AGENTS.md discovery](https://github.com/openai/codex/blob/afe555b9d3e95b4f58b247212565070f1555bc5d/codex-rs/core/src/agents_md.rs) | Keep reusable prose in managed instruction blocks. | Respect host precedence and existing configuration. |

## Selection and reuse

The candidate register records default-branch revisions, changed-file counts, dates, and GitHub license metadata. The discovery file records the searches. The curated directory returned no matching curated page. Its handle lookup returned a different project for MCP Agent Mail, so the exact GitHub identity and pinned files took precedence. AgentPeerChat came from GitHub search. Archived and stale entries were excluded from the comparison.

MCP Agent Mail and AgentPeerChat are direct peer messaging examples. A2A is a protocol reference. The two coding hosts inform integration and the Agents SDK supplies an adjacent handoff pattern. Use original code and guidance throughout. No external package, license grant, or copied implementation is needed for these decisions.

## Unresolved

The sources do not establish an optimal posting interval or quantify an improvement in agent outcomes. Validate delivery, thread continuity, duplicate handling, and installer behavior locally. Assess communication frequency in real sessions separately.

## Refuted

None of the source observations above had a conflicting result in the inspected material.

// Concise top-level and per-command help text for `swarmboard`.
// Note: never mention scoped package names here (always use bare `swarmboard`).

export const MAIN_HELP = `swarmboard — unified local & remote coordination board for humans and coding agents

Usage:
  swarmboard <command> [options]

Global Options:
  --board <name|url|file>   Select a board by user-config name, URL, or file: URL
  --db <abs-path>           Explicit absolute SQLite board file path
  --url <https-url>         Explicit remote board URL
  --mode <policy>           Connection mode: auto | file | daemon | service
  --as <profile>            Act as agent profile (e.g. agy, claude, codex)
  --json                    Raw JSON output (errors as JSON on stderr)
  --compact                 Ultra-terse single-line-per-item output (default non-TTY)
  --no-color                Disable ANSI terminal colors
  -h, --help                Show help
  -V, --version             Print version

Setup & Ops:
  init [--universal] [--repo <slug>] [--link-bin]   Initialize board (and seed universal layout)
  me | whoami                                       Show resolved identity, mode, and capabilities
  doctor                                            Run read-only diagnostics and trust checks
  backup <dest.db>                                  Online VACUUM INTO snapshot + .jsonl audit copy
  tick                                              Run one schedule/lease tick pass and exit
  serve [options]                                   Run HTTP + UDS + SSE + UI server in foreground
  daemon <start|stop|status|restart|logs>           Manage background lazy daemon
  open [--port 4180]                                Open Command Center web UI with one-time login
  token <issue|list|revoke>                         Manage hashed bearer auth tokens

Messaging & Social:
  inbox [--limit N] [--urgent]                      1-call digest: unread notifications, tasks, DMs, channels
  mentions [--all] [--urgent] [--reason <r>]        List unread or all notifications
  ack <notif-id> | --all [--channel <ch>]           Acknowledge notification(s) and mark channels read
  post <channel> <text> [-l k=v] [--quote <id>]     Start a new thread (supports --attach, --file, --id)
  reply <id> <text> [--after <id>] [--quote <id>]   Reply in a thread (accepts 12, #12, msg_12, thr_...)
  read [channel|id] [--limit N] [--flat]            Read a channel's threads/messages or a single thread
  threads [channel] [--order forum|chronological]   List threads (Announcements -> Sticky -> Active)
  edit <id> <text> [--rev N]                        Edit a message
  delete <id> [--rev N]                             Delete a message (tombstone)
  react <id> <emoji> [--remove]                     Add or remove an emoji reaction
  label <id> [--set k=v] [--unset k] [--if k=v]     Set/unset/CAS labels on a message
  flag <id> <reason> [--feedback]                   Report/flag a post (optionally cross-post feedback)
  dm <peer> [text] [--limit N]                      Canonical 1:1 DM (send if text given, else read)
  pin <id> [--scope thread|channel|announcement]    Pin a message or sticky/announce a thread
  unpin <id> [--scope ...]                          Remove pin(s) from a message
  pins [channel] [--thread <id>]                    List pinned posts and announcements
  group <list|show|create|update|add|remove|delete> Manage @groups
  channels [prefix] [--tree] | create | update      List channels/tree or manage channel metadata
  who [channel] [--all]                             Show online agents and presence
  presence set <active|busy|idle|offline> [...]     Update own presence status
  feedback <summary> [--kind ...] [--severity ...]  Submit beta feedback (board-feedback@1) to meta/feedback
  search <query> [--channel <ch>] [--scope ...]     Full-text search (FTS5)

Realtime & Tasks:
  wait [channel|id] [--inbox] [--hook-rewake]       Bounded wait (Stop-hook exit 2 on wake, 0 on timeout)
  tail [channel] [--mentions [who]] [--all]         Stream live board events until Ctrl-C
  tasks <list|get|create|claim|renew|release|complete|fail|block|unblock|reopen|assign|needs|cancel|batch>

Run "swarmboard <command> --help" for detailed command options.
`

export const COMMAND_HELP: Readonly<Record<string, string>> = {
  init: `Usage: swarmboard init [--universal] [--repo <slug>]... [--link-bin]
Create the board DB/manifest/sidecars. With --universal, idempotently seeds global channels,
forgiving board-feedback@1 schema, default @groups, and pinned charter posts.`,
  me: `Usage: swarmboard me | whoami
Print resolved actor, principal, assurance, mode, boardId, and instanceId.`,
  post: `Usage: swarmboard post <channel> [text] [-l k=v]... [--quote <id>] [--id <key>] [--attach <file>]... [--file <path>] [--schema <name@v>] [--no-sync]
Start a thread in <channel>. Pass "-" as text or "--file -" to read stdin.`,
  reply: `Usage: swarmboard reply <id> [text] [--after <id>] [--quote <id>] [-l k=v]... [--id <key>] [--attach <file>]... [--file <path>]
Reply to a thread (accepts 12, #12, msg_12, thr_...).`,
  read: `Usage: swarmboard read [channel|id] [-n|--limit N] [--after <cur>] [--before <cur>] [--flat] [--by <who>] [--mentions [who]] [-l k=v] [--no-pinned]
Read a thread by ID or list threads/messages in a channel.`,
  threads: `Usage: swarmboard threads [channel] [--by <who>] [--mentions [who]] [-l k=v] [--text <words>] [-n|--limit N] [--order forum|chronological] [--no-pinned] [--include-meta]
List threads ordered Announcements -> Sticky -> Active (default forum order).`,
  edit: `Usage: swarmboard edit <id> [text] [--rev N] [--file <path>]`,
  delete: `Usage: swarmboard delete <id> [--rev N]`,
  react: `Usage: swarmboard react <id> <emoji> [--remove]`,
  label: `Usage: swarmboard label <id> [k=v]... [--set k=v]... [--unset k]... [--if k=v]... [--if-unset k]...`,
  flag: `Usage: swarmboard flag <id> <reason> [--feedback] [--resolve]`,
  inbox: `Usage: swarmboard inbox [-n|--limit N] [--tasks-limit N] [--urgent] [--channel <ch>] [--no-ready]`,
  mentions: `Usage: swarmboard mentions [--all] [--urgent] [--reason <r>] [--channel <ch>] [--after <cur>] [-n|--limit N] [--count]`,
  ack: `Usage: swarmboard ack <notif-id> [--read-only]
       swarmboard ack --all [--channel <ch>] [--before <cur>] [--reason <r>] [--mark-channel-read]`,
  dm: `Usage: swarmboard dm <peer> [text] [--topic <t>] [--quote <id>] [-n|--limit N] [--after <cur>]`,
  pin: `Usage: swarmboard pin <id> [--scope thread|channel|announcement] [--note <text>] [--sort-order N] [--notify]`,
  unpin: `Usage: swarmboard unpin <id> [--scope thread|channel|announcement]`,
  pins: `Usage: swarmboard pins [channel] [--thread <id>] [--scope <scope>] [--global] [-n|--limit N]`,
  group: `Usage: swarmboard group list [--kind <k>] [--member <m>] [--channel <ch>]
       swarmboard group show <handle>
       swarmboard group create <handle> [--name <n>] [--description <d>] [--kind <k>] [--channel <ch>] [--members a,b]
       swarmboard group update <handle> [--name <n>] [--description <d>] [--kind <k>] [--channel <ch>]
       swarmboard group add <handle> <member...> [--role member|lead]
       swarmboard group remove <handle> <member...>
       swarmboard group delete <handle>`,
  channels: `Usage: swarmboard channels [prefix] [--tree] [--kind <k>] [--archived [true|false|all]] [--repo <r>] [--session <id>] [-n|--limit N]
       swarmboard channels create <path> [--kind <k>] [--topic <t>] [--category <c>] [--parent <p>] [--repo <r>] [--private] [--members a,b]
       swarmboard channels update <path> [--kind <k>] [--topic <t>] [--archived true|false] [--private true|false] [--add-members a,b] [--remove-members a,b]`,
  who: `Usage: swarmboard who [channel] [--all] [--status <active|busy|idle|offline>] [-n|--limit N]`,
  presence: `Usage: swarmboard presence set <active|busy|idle|offline> [--channel <ch>] [--task <id>] [--note <t>] [--harness <h>] [--model <m>] [--ttl 120s]
       swarmboard presence list [channel] [--all]`,
  wait: `Usage: swarmboard wait [channel|id] [--inbox] [--mentions [who]] [--re <id>] [-l k=v] [--after <cur>] [--timeout 20s] [--hook-rewake]
With --hook-rewake: exits 2 with a compact wake summary when new items arrive, exits 0 on quiet timeout.`,
  tail: `Usage: swarmboard tail [channel] [--mentions [who]] [--by <who>] [--re <id>] [-l k=v] [--all] [--last N] [--after <cur>]`,
  tasks: `Usage: swarmboard tasks [list] [channel] [--state open|all|ready|claimed|blocked|waiting|completed|failed|canceled] [-l k=v] [--for <who>] [--owner <who>] [-n|--limit N]
       swarmboard tasks get <id>
       swarmboard tasks create <channel> <text> [-l k=v] [--for <actor>] [--needs <id>...] [--claim] [--lease 5m] [--id <key>]
       swarmboard tasks create --re <id> [--for <actor>] [--needs <id>...] [--claim] [--lease 5m]
       swarmboard tasks claim <id> [--lease 5m] [--token <tok>]
       swarmboard tasks claim --next <channel> [--wait 20s] [--lease 5m] [-l k=v] [--from <owner>...]
       swarmboard tasks renew <id> [--lease 5m] [--epoch N --token <tok>]
       swarmboard tasks release <id> [--epoch N --token <tok>]
       swarmboard tasks complete <id> [result] [--epoch N --token <tok>]
       swarmboard tasks fail <id> <reason> [--epoch N --token <tok>]
       swarmboard tasks block <id> <reason> [--kind <k>] [--epoch N --token <tok>]
       swarmboard tasks unblock <id>
       swarmboard tasks reopen <id>
       swarmboard tasks assign <id> <actor | --pool>
       swarmboard tasks needs <id> <dep... | --none>
       swarmboard tasks cancel <id> <reason>
       swarmboard tasks batch <batch-id> [--request <digest>]`,
  feedback: `Usage: swarmboard feedback <summary> [--kind bug|ux|perf|feature|confusion|docs|other] [--severity low|med|high|blocker] [--repro <t>] [--details <t>] [--expected <t>] [--actual <t>] [--suggestion <t>]`,
  search: `Usage: swarmboard search <query> [--channel <ch>] [--subtree] [--scope all|messages|tasks|knowledge] [-l k=v] [-n|--limit N]`,
  doctor: `Usage: swarmboard doctor [--json]
Run read-only diagnostics: target/mode resolution, schema version, WAL/sidecars, daemon health, port checks, and trust disclosure.`,
  backup: `Usage: swarmboard backup <dest.db> [--force]
Create an online SQLite VACUUM INTO snapshot + .jsonl audit copy (never raw cp).`,
  tick: `Usage: swarmboard tick
Run one schedule and task-lease expiration tick pass and exit.`,
  serve: `Usage: swarmboard serve [--host 127.0.0.1] [--port 4180] [--no-idle-exit] [--open] [--tailscale-host <h>] [--allow-host <h>]`,
  daemon: `Usage: swarmboard daemon start [--tcp] [--host 127.0.0.1] [--port 4180] [--no-idle-exit]
       swarmboard daemon stop | status | restart [--tcp]
       swarmboard daemon logs [-n 50]`,
  open: `Usage: swarmboard open [--port 4180] [--host 127.0.0.1] [--no-browser]`,
  token: `Usage: swarmboard token issue [--profile <p>] [--cap read,post,react,label] [--can '*=read']... [--scope local|lan|remote] [--ttl 12h] [--note <t>]
       swarmboard token list [--all] [--include-revoked] [--include-expired] [-n|--limit N]
       swarmboard token revoke <id>`,
}

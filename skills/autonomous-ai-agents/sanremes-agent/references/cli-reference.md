# SanRemes CLI Reference

Live sources when anything looks stale: `sanremes --help`, `sanremes <command> --help`,
https://sanremes-agent.nousresearch.com/docs/reference/cli-commands

### Global Flags

```
sanremes [flags] [command]        (no subcommand = interactive chat)

  --version, -V             Show version
  -z, --oneshot PROMPT      One-shot: print ONLY the final response (for scripts/pipes)
  -m MODEL  --provider P    Model/provider override for this invocation
  -t, --toolsets LIST       Comma-separated toolsets for this invocation
  --resume, -r SESSION      Resume session by ID or title
  --continue, -c [NAME]     Resume by name, or most recent session
  --worktree, -w            Isolated git worktree mode (parallel agents)
  --skills, -s SKILL        Preload skills (comma-separate or repeat)
  --profile, -p NAME        Use a named profile
  --yolo                    Skip dangerous command approval
  --tui / --cli             Force the Ink TUI / classic REPL
  --ignore-rules            Skip AGENTS.md/SOUL.md/memory/skill injection
  --safe-mode               Disable ALL customizations (troubleshooting)
  --pass-session-id         Include session ID in system prompt
```

### Chat

```
sanremes chat [flags]
  -q, --query TEXT          Single query, non-interactive
  --image PATH              Attach a local image to a single query
  -Q, --quiet               Suppress banner, spinner, tool previews
  --checkpoints             Enable filesystem checkpoints (/rollback)
  --max-turns N             Cap tool-calling iterations
  --source TAG              Session source tag (default: cli)
```
(plus the global flags above)

### Configuration

```
sanremes setup [section]      Wizard (model|tts|terminal|gateway|tools|agent)
sanremes model                Interactive model/provider picker
sanremes fallback [add|remove|list]  Fallback provider chain
sanremes config [show|edit|get|set|unset|path|env-path|check|migrate]
sanremes login / logout       OAuth sign-in / clear stored auth
sanremes doctor [--fix]       Check dependencies and config
sanremes status [--all]       Component status
```

### Tools & Skills

```
sanremes tools [list|enable NAME|disable NAME]   Per-platform toolsets (curses UI with no args)

sanremes skills list|browse|search QUERY|inspect ID
sanremes skills install ID    Hub identifier OR a direct https://…/SKILL.md URL
sanremes skills config        Enable/disable skills per platform
sanremes skills check|update|uninstall|publish PATH
sanremes skills tap add REPO  Add a GitHub repo as a skill source
sanremes bundles              Skill bundles (one /<name> alias loads several skills)
```

### MCP Servers

```
sanremes mcp add NAME (--url or --command) | remove | list | test NAME
sanremes mcp catalog | install NAME     Curated catalog install
sanremes mcp configure NAME             Toggle tool selection
sanremes mcp serve                      Run SanRemes as an MCP server
```
Details (transport, tool discovery, catalog): `references/native-mcp.md`.

### Gateway (Messaging Platforms)

```
sanremes gateway run|install|start|stop|restart|status|setup
```

20+ platforms: Telegram, Discord, Slack, WhatsApp (Baileys + Business Cloud API), iMessage (Photon — `sanremes photon setup`), Signal, Email, SMS, Matrix, Mattermost, Teams, LINE, SimpleX, ntfy, Google Chat, Home Assistant, DingTalk, Feishu, WeCom, Weixin, API Server, Webhooks. Open WebUI connects via the API Server adapter. Most adapters ship under `plugins/platforms/`.
Docs: https://sanremes-agent.nousresearch.com/docs/user-guide/messaging/

### Sessions

```
sanremes sessions list|browse|rename ID TITLE|delete ID|export OUT|prune|stats
```

### Cron / Webhooks

```
sanremes cron list|create SCHED|edit ID|pause|resume|run ID|remove|status
    Schedules: '30m', 'every 2h', '0 9 * * *', ISO timestamp
sanremes webhook subscribe NAME|list|remove NAME|test NAME
```
Webhook payloads/routes: `references/webhooks.md`.

### Profiles

```
sanremes profile list|create NAME (--clone|--clone-all|--clone-from)|use|show|delete
sanremes profile rename A B | alias NAME | export NAME | import FILE
```

### Credentials & Pools

```
sanremes auth                 Interactive credential manager
sanremes auth add [PROVIDER]  Add OAuth or API-key credential (nous, openai-codex, qwen-oauth, …)
sanremes auth list|remove P IDX|reset PROVIDER|status
```
Multiple credentials per provider form a pool that rotates automatically and skips exhausted keys.

### Other

```
sanremes desktop / gui        Native desktop app
sanremes dashboard            Web admin panel + embedded chat (--stop / --status)
sanremes proxy                OpenAI-compatible local proxy backed by an OAuth provider
sanremes portal               Quick setup / sign in via Nous Portal
sanremes kanban <verb>        Multi-agent work-queue board
sanremes project              Named multi-folder workspaces
sanremes skin list|use|set    Switch/tweak skins (see references/themes.md)
sanremes pets <verb>          Pet mascots (see references/petdex.md)
sanremes memory setup|status|off|reset   Memory provider
sanremes secrets bitwarden|onepassword   External secret stores
sanremes moa                  Mixture-of-Agents slots
sanremes hooks / security / backup / import / checkpoints / console
sanremes logs [-f] [errors]   View agent/error logs
sanremes send                 One-off message through a gateway platform
sanremes pairing / plugins / insights / journey / computer-use
sanremes acp                  ACP server (IDE integration)
sanremes completion bash|zsh|fish
sanremes update / uninstall / claw migrate
```

Plugin- and provider-supplied subcommands (e.g. `sanremes photon setup`) only appear once their plugin is installed/active.

### Where to Find Things

| Looking for... | Location |
|---|---|
| Config options | `sanremes config edit` · [Configuration docs](https://sanremes-agent.nousresearch.com/docs/user-guide/configuration) |
| Tools / toolsets | `sanremes tools list` · [Tools reference](https://sanremes-agent.nousresearch.com/docs/reference/tools-reference) |
| Skills catalog | `sanremes skills browse` · [Skills catalog](https://sanremes-agent.nousresearch.com/docs/reference/skills-catalog) |
| Provider setup | `sanremes model` · [Providers guide](https://sanremes-agent.nousresearch.com/docs/integrations/providers) |
| Env variables | `sanremes config env-path` · [Env vars reference](https://sanremes-agent.nousresearch.com/docs/reference/environment-variables) |
| Gateway logs | `~/.sanremes/logs/gateway.log` (or `sanremes logs`) |
| Sessions | `sanremes sessions browse` (reads state.db) |

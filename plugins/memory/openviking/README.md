# OpenViking Memory Provider

Context database by Volcengine (ByteDance) with filesystem-style knowledge hierarchy, tiered retrieval, and automatic memory extraction.

## Requirements

- OpenViking installed with the `openviking-server` command available
- OpenViking server config initialized and validated (`openviking-server init`,
  then `openviking-server doctor`)
- OpenViking server running and reachable from SanRemes

OpenViking 0.2.10 or newer is recommended. For backward compatibility,
SanRemes can identify older servers that expose the legacy status-only health
response, but only when anonymous OpenAPI metadata also identifies the service
as OpenViking. OpenViking 0.2.6 and earlier are deprecated for this integration;
upgrade them to receive the current health contract and compatibility fixes.

## Setup

Prepare OpenViking first:

```bash
openviking-server init
openviking-server doctor
openviking-server
```

Then configure SanRemes:

```bash
sanremes memory setup    # select "openviking"
```

The setup can link to an existing `~/.openviking/ovcli.conf`, copy its current
connection values into SanRemes, or create a minimal `ovcli.conf` when one does
not exist.

Or manually:

```bash
sanremes config set memory.provider openviking
```

Add the connection settings to the active profile's `.env` file. For the
default profile that is `~/.sanremes/.env`; for a named profile use
`~/.sanremes/profiles/<profile>/.env`.

```text
OPENVIKING_ENDPOINT=http://127.0.0.1:1933
# OPENVIKING_API_KEY=...
# OPENVIKING_ACCOUNT=default
# OPENVIKING_USER=default
# OPENVIKING_AGENT=sanremes
```

## Config

OpenViking's server config is separate from SanRemes:

- `ov.conf` configures OpenViking storage, embedding/VLM models, auth, and
  server behavior. OpenViking reads it from `--config`,
  `OPENVIKING_CONFIG_FILE`, or `~/.openviking/ov.conf`.
- `ovcli.conf` stores client/CLI connection values such as `url`, `api_key`,
  `account`, and `user`. It is read from `OPENVIKING_CLI_CONFIG_FILE` or
  `~/.openviking/ovcli.conf`.

SanRemes-side provider config is read from environment variables in the active
profile's `.env`:

| Env Var | Default | Description |
|---------|---------|-------------|
| `OPENVIKING_ENDPOINT` | `http://127.0.0.1:1933` | Server URL |
| `OPENVIKING_API_KEY` | (none) | User/admin API key for authenticated servers |
| `OPENVIKING_ACCOUNT` | `default` | Tenant account for local/trusted mode |
| `OPENVIKING_USER` | `default` | Tenant user for local/trusted mode |
| `OPENVIKING_AGENT` | `sanremes` | SanRemes peer ID in OpenViking, used for peer-scoped memories |

When `OPENVIKING_API_KEY` is set, SanRemes lets OpenViking derive account/user
identity from the key. In local or trusted deployments without an API key,
SanRemes sends `OPENVIKING_ACCOUNT` and `OPENVIKING_USER` as identity headers.
SanRemes also sends `User-Agent: openviking-memory-sanremes/<version>` on
OpenViking requests. This standard harness identifier contains the SanRemes
version, but no per-user identifier, and does not add a separate request.

## Tools

| Tool | Description |
|------|-------------|
| `viking_search` | Semantic search with fast/deep/auto modes |
| `viking_read` | Read content at a viking:// URI (abstract/overview/full) |
| `viking_browse` | Filesystem-style navigation (list/tree/stat) |
| `viking_remember` | Store a fact directly with OpenViking `content/write` |
| `viking_forget` | Delete one exact `viking://` memory file URI |
| `viking_add_resource` | Ingest URLs/docs into the knowledge base |

## Memory Writes And Deletes

`viking_remember` writes directly to OpenViking with `POST /api/v1/content/write`
and `mode=create`. It creates peer-scoped memory files under explicit-uid
`viking://user/<user>/peers/${OPENVIKING_AGENT}/memories/...` URIs, where
`<user>` is resolved client-side from `/api/v1/system/status` (server-asserted
current user). SanRemes caches a confirmed user only for the active connection.
If the probe fails, SanRemes uses the configured user, or `default`, for that
operation and retries the probe later. Explicit-uid URIs are canonical and
work under every OpenViking auth mode and version; the `viking://~` alias only
expands for USER/ADMIN roles, not the default dev mode.
Explicit remembers do not depend on session commit extraction.

SanRemes built-in `memory` tool additions are mirrored to OpenViking after the
local memory operation succeeds:

| SanRemes action | OpenViking operation |
|---------------|----------------------|
| `add` | `content/write` with `mode=create` under the configured peer memory namespace |

Built-in `replace` and `remove` operations are not mirrored because SanRemes
native memory entries do not yet carry stable OpenViking file URIs. Use
`viking_forget` when the user explicitly asks to delete a specific OpenViking
memory URI.

`viking_forget` is intentionally narrow. It only accepts concrete user memory
file URIs, such as
`viking://user/default/peers/sanremes/memories/preferences/mem_abc123.md` (any
explicit user id works; `viking://~/...` input is passed through untouched for
deployments where the server expands the home alias). Files
directly under `memories/`, such as `viking://user/default/memories/profile.md`,
are also allowed because OpenViking supports them. The tool rejects directories,
resources, skills, sessions, generated summary files, and URIs with query
strings or fragments. Use OpenViking's MCP, CLI, or admin APIs for broader
resource and directory cleanup.

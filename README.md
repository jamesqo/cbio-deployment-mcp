# cBioPortal deployment MCP

A Bun/TypeScript stdio MCP for disposable cBioPortal instances on a local Docker daemon.
Each deployment has a loopback port, ClickHouse database, MongoDB session volume, and
backend image. Browser acceptance testing stays in the Playwright MCP; `api_request`
supports API checks against the same instance.

## Run

### Container on Linux

```sh
docker build -t cbio-deployment-mcp:local .
./docker/run.sh /absolute/path/to/local/repos /absolute/path/to/studies
```

The image includes Bun, Git, CA certificates, and Docker CLI with Compose and
Buildx. Backend/importer builds supply their own Java, Maven and Python environments.
Playwright stays separate from the MCP runtime.

Use the absolute path to `docker/run.sh` as your MCP client's `command`, with
optional repo/study directories in `args`. It runs stdio without a TTY. Set
`CBIO_MCP_IMAGE` to choose the image and `CBIO_MCP_HOME` to choose the state directory.

This uses the host Docker socket, so deployments belong to the host daemon;
DinD is not required. The launcher uses host networking to reach deployment
loopback ports, keeps the host UID/GID and adds the socket group. It mounts state
at the same absolute path on both sides so Docker can resolve sibling-container
bind mounts. Local input directories are mounted read-only. Use one server per
state directory. This launcher targets Linux Docker Engine.

### Directly with Bun

Requires Bun, Git, Docker with Compose, and enough memory for Maven builds and cBioPortal.
The first build downloads Maven dependencies and Docker images.

```sh
bun install
bun run check
bun run build
bun run start
```

If your shell needs Docker group access, run `sg docker -c 'bun run start'`.
A generic MCP client entry is:

```json
{
  "mcpServers": {
    "cbio-deployment": {
      "command": "/home/james/.local/bin/bun",
      "args": ["/home/james/scratch/cbio-deployment-mcp/src/server.ts"]
    }
  }
}
```

The client process needs access to the Docker socket. `DOCKER_HOST` may specify a local
Unix socket; remote Docker hosts are rejected. State, private generated credentials,
source snapshots and operation logs live under `CBIO_MCP_HOME`, defaulting to
`~/.local/share/cbio-deployment-mcp`. Run one server per state directory.

## Deploy sources

Call `deploy` with a local clone:

```json
{
  "cbioportal": { "kind": "local", "path": "/home/james/work/cbioportal" },
  "core": { "kind": "local", "path": "/home/james/work/cbioportal-core" },
  "port": 18080,
  "database": "cbioportal",
  "properties": { "skin.title": "Feature test" }
}
```

Or combine branches and PRs independently for the backend and importer:

```json
{
  "cbioportal": {
    "kind": "github",
    "base": { "ref": "HEAD" },
    "merge": [{ "pr": 100 }, { "ref": "feature-branch" }]
  },
  "core": {
    "kind": "github",
    "base": { "ref": "HEAD" },
    "merge": [{ "pr": 183 }, { "pr": 191 }]
  },
  "port": 18081
}
```

The numbers above illustrate the input format; choose compatible changes for an actual run.
`merge` is ordered and also accepts local branch refs when `kind` is `local`.
Local sources can specify `ref`, or `includeUncommitted: true` to copy the current
checkout's tracked edits and untracked, nonignored files. Dirty snapshots cannot also
select or merge another ref. Original checkouts are never changed. GitHub refs can be
branches, tags or commit SHAs. Both repositories are fixed to the cBioPortal organization.

Merge conflicts stop the operation and report conflicting files and the scratch checkout.
Resolve and commit them in that checkout, then use it as a local source. Existing running
containers are untouched by a failed build or importer merge. Default `redeploy` rebuilds
the saved backend snapshot; `refreshRefs: true` fetches/resnapshots current sources and
invalidates the cached importer image. The optional core source controls the importer,
not a backend Maven dependency. If omitted, core defaults to the GitHub repository’s default branch.

## Tools

| Tool | Behavior |
| --- | --- |
| `deploy` | Build/start; returns a deployment ID and URL immediately. |
| `list_deployments`, `status` | Saved state, resolved revisions, current operation and progress. |
| `logs` | Bounded operation logs, or `app`, `database`, `session`, `mongo` logs. |
| `configure` | Merge application properties or change the loopback port; recreate backend. |
| `restart` | Restart backend and wait for readiness. |
| `redeploy` | Rebuild image while preserving data, configuration and port. |
| `import_studies` | Copy and sequentially import local study directories, rebuild derived tables, refresh backend. |
| `api_request` | Call this instance's `/api/...` endpoints with query parameters and optional JSON. |
| `destroy` | Stop containers; `deleteData: true` also removes this deployment's database/session volumes. |

Poll `status` until `phase` is `ready` before testing. Operations on one deployment are
serialized. Interrupted operations are reported as failed on the next MCP startup;
containers already running remain available. Readiness is checked at the end of each
operation, not continuously monitored. Database schema migrations across incompatible
backend versions are outside this prototype; use a new deployment for those changes.

Import example:

```json
{
  "id": "cbio-mcp-012345abcdef",
  "studies": ["/path/to/study_one", "/path/to/study_two"],
  "waitForCompletion": true,
  "overrideWarnings": false
}
```

Each directory must contain `meta_study.txt`. Supply optional `genePanels: ["/path/to/panel.txt"]`
when studies require gene panels that are absent from the new database; these are imported before the first study. Core builds lazily on the first import.
Background mode is the default: poll `status` for stage/study counts and `logs` for importer
output. `waitForCompletion` keeps the call open and sends MCP progress notifications when
the client supplies a progress token. Clients must support progress and allow a sufficiently
long call timeout. Cancelling that waiting request cancels the import operation. Multiple
study imports are not transactional; a failure can leave earlier studies imported. The
original study directories remain unchanged.

API example (GET is the default):

```json
{
  "id": "cbio-mcp-012345abcdef",
  "method": "POST",
  "path": "/api/studies/fetch",
  "body": ["study_one"],
  "query": { "projection": "SUMMARY" }
}
```

Responses include HTTP status, `ok`, JSON/text body and a truncation flag. Calls have bounded
timeouts and payload sizes. Database addresses and credentials are generated internally.
`destroy` preserves build images and snapshots for inspection and Docker cache reuse.

## Validation

`bun run check` covers Git snapshots and merges, conflicts, deployment isolation, failed
replacement builds, API requests, stdio MCP interoperability and streamed import progress.
`sg docker -c 'bun test/smoke.ts'` is a separate real Docker build/import/configure/restart/redeploy smoke test
using the local cBioPortal/core clones; it removes its dedicated containers and data afterward.

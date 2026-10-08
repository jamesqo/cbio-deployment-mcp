import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod/v4";
import { deploySchema } from "../src/deployments";
import { run } from "../src/process";

const image = process.env.CBIO_MCP_IMAGE ?? "cbio-deployment-mcp:local";
const root = await mkdtemp(join(tmpdir(), "cbio-container-"));
const socket = "/var/run/docker.sock";
const socketGroup = String((await stat(socket)).gid);
const uid = process.getuid?.();
const gid = process.getgid?.();
assert.ok(uid !== undefined && gid !== undefined, "Requires Linux UID/GID");
const http = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => Response.json({ reachedHostLoopback: true }),
});
const id = "cbio-mcp-abcdef123456";
const directory = join(root, id);
await mkdir(directory);
await writeFile(
  join(directory, "state.json"),
  JSON.stringify({
    ...deploySchema.parse({
      cbioportal: { kind: "local", path: root },
      port: Number(http.url.port),
    }),
    id,
    password: "private",
    image: "unused",
    generation: 1,
    resolved: [],
    phase: "ready",
    operation: "fixture",
    updatedAt: "now",
  }),
);
await writeFile(join(root, "probe.txt"), "shared-path-probe\n");
const client = new Client({ name: "container-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: resolve("docker/run.sh"),
  args: [resolve("src")],
  env: { ...process.env, CBIO_MCP_HOME: root, CBIO_MCP_IMAGE: image },
});
try {
  // Exercise the actual image's CLI/plugins and a sibling bind mount created
  // through the mounted host socket, using the same non-root/socket-group setup.
  const probe = await run([
    "docker",
    "run",
    "--rm",
    "--memory",
    "512m",
    "--user",
    `${uid}:${gid}`,
    "--group-add",
    socketGroup,
    "-v",
    `${socket}:${socket}`,
    "-v",
    `${root}:${root}`,
    "--entrypoint",
    "sh",
    image,
    "-ec",
    'git --version; docker version --format "{{.Server.Version}}"; docker compose version; docker buildx version; docker run --rm --memory 64m -v "$1:/probe:ro" --entrypoint cat "$2" /probe/probe.txt',
    "sh",
    root,
    image,
  ]);
  assert.match(probe, /git version/);
  assert.match(probe, /Docker Compose version/);
  assert.match(probe, /buildx/);
  assert.match(probe, /shared-path-probe/);
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 12);
  const response = await client.callTool({
    name: "api_request",
    arguments: { id, path: "/api/info" },
  });
  assert.notEqual(response.isError, true);
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .parse(response.content);
  const payload = z
    .object({
      status: z.literal(200),
      body: z.object({ reachedHostLoopback: z.literal(true) }),
    })
    .parse(JSON.parse(content[0]?.text ?? "null"));
  assert.equal(payload.status, 200);
  console.log(
    "PASS: image tools, host Docker socket, sibling bind mounts, non-root stdio MCP, and host loopback API access",
  );
} finally {
  await client.close();
  await http.stop(true);
  await rm(root, { recursive: true, force: true });
}

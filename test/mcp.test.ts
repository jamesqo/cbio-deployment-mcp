import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio server lists tools and returns validated responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "cbio-mcp-wire-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/server.ts")],
    env: { ...process.env, CBIO_MCP_HOME: root },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("import_studies");
    expect(tools.tools).toHaveLength(10);
    const deployments = await client.callTool({
      name: "list_deployments",
      arguments: {},
    });
    expect(deployments.isError).not.toBe(true);
    const invalid = await client.callTool({
      name: "deploy",
      arguments: {
        cbioportal: { kind: "github", base: { ref: "master", pr: 183 } },
      },
    });
    expect(invalid.isError).toBe(true);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("waiting imports stream progress through the MCP protocol and retain data operation results", async () => {
  const { InMemoryTransport } = await import("@modelcontextprotocol/client");
  const { createMcpServer } = await import("../src/server");
  const { Deployments, deploySchema } = await import("../src/deployments");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cbio-mcp-progress-"));
  const id = "cbio-mcp-abcdef123456";
  const directory = join(root, id);
  await mkdir(join(directory, "runtime"), { recursive: true });
  const study = join(root, "study");
  await mkdir(study);
  await writeFile(
    join(study, "meta_study.txt"),
    "cancer_study_identifier: test\n",
  );
  const secondStudy = join(root, "second-study");
  await mkdir(secondStudy);
  await writeFile(
    join(secondStudy, "meta_study.txt"),
    "cancer_study_identifier: test2\n",
  );
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json([]),
  });
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      ...deploySchema.parse({
        cbioportal: { kind: "local", path: root },
        port: Number(http.url.port),
      }),
      id,
      password: "private",
      image: "backend:1",
      importerImage: "core:1",
      generation: 1,
      resolved: [],
      phase: "ready",
      operation: "deploy",
      updatedAt: "now",
    }),
  );
  const importedMeta: string[] = [];
  const service = new Deployments(root, async (argv) => {
    if (argv.includes("run")) {
      const mount = argv.find((value) => value.endsWith(":/study"));
      if (!mount) throw new Error("Missing study mount");
      importedMeta.push(
        await readFile(join(mount.slice(0, -7), "meta_study.txt"), "utf8"),
      );
    }
    await Bun.sleep(50);
    return "";
  });
  await service.initialize();
  const server = createMcpServer(service);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const notifications: number[] = [];
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool(
      {
        name: "import_studies",
        arguments: {
          id,
          studies: [study, secondStudy],
          waitForCompletion: true,
        },
      },
      { onprogress: (progress) => notifications.push(progress.progress) },
    );
    expect(response.isError).not.toBe(true);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.at(-1)).toBe(5);
    expect(importedMeta).toEqual([
      "cancer_study_identifier: test\n",
      "cancer_study_identifier: test2\n",
    ]);
    expect(service.status(id).phase).toBe("ready");
    expect(service.status(id).progress?.stage).toBe("Complete");
  } finally {
    await client.close();
    await server.close();
    await service.close();
    await http.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

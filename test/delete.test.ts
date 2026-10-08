import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Deployments, deploySchema } from "../src/deployments";
import { createMcpServer } from "../src/server";

for (const mode of [
  "success",
  "cancel",
  "delete-failure",
  "derive-failure",
  "refresh-failure",
  "silent-failure",
] as const) {
  test(`batch deletion: ${mode}, progress and owned cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cbio-delete-"));
    const id = "cbio-mcp-abcdef123456";
    const directory = join(root, id);
    let studies = ["first", "second", "keep"];
    const http = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json(studies.map((studyId) => ({ studyId }))),
    });
    await mkdir(join(directory, "runtime"), { recursive: true });
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
    const calls: string[][] = [];
    let deletionStarted = false;
    let entered: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const service = new Deployments(root, async (argv, options) => {
      calls.push(argv);
      if (argv.includes("run")) {
        deletionStarted = true;
        if (mode === "delete-failure") throw new Error("Importer failed");
        expect(argv.at(-1)).toBe("first,second");
        expect(argv).toContain(`${directory}/runtime:/runtime:ro`);
        expect(argv).toContain(`${id}_default`);
        expect(argv).toContain("4g");
        entered?.();
        if (mode === "cancel") {
          const signal = options?.signal;
          if (!signal) throw new Error("Missing cancellation signal");
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
        }
        if (mode !== "silent-failure") studies = ["keep"];
      }
      if (argv.includes("ps")) return "owned-container";
      if (
        (mode === "refresh-failure" ||
          (mode === "derive-failure" && deletionStarted)) &&
        argv.includes("exec")
      )
        throw new Error("Derived tables failed");
      return "";
    });
    const server = createMcpServer(service);
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await service.initialize();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const studyIds of [
        [],
        ["first", "missing"],
        ["first", "first"],
        ["first,second"],
        ["--all"],
      ]) {
        await expect(service.deleteStudies({ id, studyIds })).rejects.toThrow();
      }
      expect(calls).toHaveLength(0);
      const refresh = await client.callTool({
        name: "refresh_derived_tables",
        arguments: { id, waitForCompletion: true },
      });
      if (mode === "refresh-failure") {
        expect(refresh.isError).toBe(true);
        expect(studies).toEqual(["first", "second", "keep"]);
        expect(service.status(id).phase).toBe("failed");
        expect(
          calls.some((argv) => argv.includes("up") && argv.at(-1) === "app"),
        ).toBe(true);
        return;
      }
      expect(refresh.isError).not.toBe(true);
      expect(studies).toEqual(["first", "second", "keep"]);
      expect(calls.some((argv) => argv.includes("run"))).toBe(false);
      expect(service.status(id).progress?.completed).toBe(3);
      const notifications: number[] = [];
      const pending = client.callTool(
        {
          name: "delete_studies",
          arguments: {
            id,
            studyIds: ["first", "second"],
            waitForCompletion: true,
          },
        },
        {
          onprogress: (progress) => notifications.push(progress.progress),
        },
      );
      if (mode === "cancel") {
        await running;
        await expect(
          service.deleteStudies({ id, studyIds: ["first"] }),
        ).rejects.toThrow("ready and idle");
        service.cancel(id);
      }
      const response = await pending;
      expect(response.isError === true).toBe(mode !== "success");
      expect(service.status(id).phase).toBe(
        mode === "success" ? "ready" : "failed",
      );
      expect(
        calls.some(
          (argv) => argv.includes("rm") && argv.at(-1) === `${id}-delete`,
        ),
      ).toBe(true);
      expect(
        calls.some((argv) => argv.includes("up") && argv.at(-1) === "app"),
      ).toBe(true);
      if (mode === "success") {
        expect(studies).toEqual(["keep"]);
        expect(notifications.at(-1)).toBe(4);
        expect(service.status(id).operation).toBe("Deleted 2 studies");
      }
    } finally {
      await client.close();
      await server.close();
      await service.close();
      await http.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
}

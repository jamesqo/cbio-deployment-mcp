import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deployments, deploySchema } from "../src/deployments";
import type { DeploymentRuntime } from "../src/runtime";

test("an injected runtime manages studies and services without invoking Docker", async () => {
  // GIVEN a restored portal and a runtime that owns its services and data.
  const root = await mkdtemp(join(tmpdir(), "cbio-runtime-"));
  const id = "cbio-mcp-abcdef123456";
  const directory = join(root, id);
  let studies = ["remove", "keep"];
  let running = true;
  let retainedData = true;
  const http = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      running
        ? Response.json(studies.map((studyId) => ({ studyId })))
        : new Response("Stopped", { status: 503 }),
  });
  const runtime: DeploymentRuntime = {
    async prepare() {},
    async build() {
      throw new Error("Restored importer should be reused");
    },
    async up() {
      running = true;
    },
    async stopApp() {
      running = false;
    },
    async restartApp() {
      running = true;
    },
    async execDatabase() {},
    async runImporter(_context, task) {
      if (task.operation === "delete") {
        const deleted = task.args[0]!.split(",");
        studies = studies.filter((id) => !deleted.includes(id));
      } else {
        const metadata = await Bun.file(
          join(task.study!, "meta_study.txt"),
        ).text();
        studies.push(metadata.trim().split(": ")[1]!);
      }
    },
    async logs() {
      return "portal ready; credential=private";
    },
    async destroy(_context, deleteData) {
      running = false;
      if (deleteData) retainedData = false;
    },
  };
  const service = new Deployments(
    root,
    async () => {
      throw new Error("The workflow must not call Docker outside its runtime");
    },
    runtime,
  );
  try {
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
    const study = join(root, "input-study");
    await mkdir(study);
    await writeFile(
      join(study, "meta_study.txt"),
      "cancer_study_identifier: added\n",
    );
    await service.initialize();

    // WHEN the usual workflow runs through the replacement runtime.
    await service.importStudies({ id, studies: [study] });
    await service.idle(id);
    expect(service.status(id).phase).toBe("ready");
    expect(studies).toEqual(["remove", "keep", "added"]);

    await service.deleteStudies({ id, studyIds: ["remove"] });
    await service.idle(id);
    service.configure(id, { properties: { "app.name": "Configured portal" } });
    await service.idle(id);
    service.restart(id);
    await service.idle(id);

    // THEN API checks, redaction and data-retaining shutdown still work.
    expect(service.status(id).phase).toBe("ready");
    expect((await service.api(id, { path: "/api/studies" })).body).toEqual([
      { studyId: "keep" },
      { studyId: "added" },
    ]);
    expect(await service.logs(id, "app")).toBe(
      "portal ready; credential=[redacted]",
    );
    service.destroy(id, false);
    await service.idle(id);
    expect(service.status(id).phase).toBe("stopped");
    expect(running).toBe(false);
    expect(retainedData).toBe(true);
    service.destroy(id, true);
    await service.idle(id);
    expect(retainedData).toBe(false);
  } finally {
    await service.close();
    http.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

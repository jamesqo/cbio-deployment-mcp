import { strict as assert } from "node:assert";
import { resolve, join } from "node:path";
import { z } from "zod/v4";
import { Deployments } from "../src/deployments";

const service = new Deployments();
await service.initialize();
const studySchema = z.array(
  z.object({ studyId: z.string(), allSampleCount: z.number() }),
);
const backend = resolve(
  process.env.CBIO_MCP_BACKEND_CLONE ?? "/home/james/work/cbioportal",
);
const fixture = join(backend, "test/test_data/study_es_0");
let id: string | undefined;

async function ready(deployment: string) {
  await service.idle(deployment);
  const state = service.status(deployment);
  assert.equal(
    state.phase,
    "ready",
    `${state.error ?? "Deployment is not ready"}\n${await service.logs(deployment)}`,
  );
  return state;
}
async function imported(deployment: string) {
  const response = await service.api(deployment, { path: "/api/studies" });
  assert.equal(response.status, 200);
  const study = studySchema
    .parse(response.body)
    .find((item) => item.studyId === "study_es_0");
  assert.ok(study, "Imported study is absent from the API");
  assert.equal(study.allSampleCount, 845);
  return study;
}

try {
  const reuse = process.env.CBIO_MCP_SMOKE_REUSE;
  const state = reuse
    ? service.redeploy(reuse, false)
    : await service.deploy({
        cbioportal: { kind: "local", path: backend },
        core: {
          kind: "local",
          path:
            process.env.CBIO_MCP_CORE_CLONE ??
            "/home/james/work/cbioportal-core",
        },
        port: 18883,
      });
  id = state.id;
  console.log("Building", id);
  await ready(id);
  assert.ok(service.list().some((item) => item.id === id));
  const before = await service.api(id, { path: "/api/studies" });
  assert.deepEqual(before.body, []);
  await service.importStudies({
    id,
    studies: [fixture],
    genePanels: [
      join(fixture, "data_gene_panel_testpanel1.txt"),
      join(fixture, "data_gene_panel_testpanel2.txt"),
    ],
    overrideWarnings: true,
  });
  await ready(id);
  console.log("Imported:", await imported(id));
  const response = await service.api(id, {
    method: "POST",
    path: "/api/studies/fetch",
    query: { projection: "DETAILED" },
    body: ["study_es_0"],
  });
  assert.equal(response.status, 200);
  assert.equal(studySchema.parse(response.body)[0]?.studyId, "study_es_0");
  const logs = await service.logs(id, "app", 20);
  assert.ok(logs.length > 0);
  service.configure(id, {
    port: 18884,
    properties: { "skin.title": "MCP acceptance test" },
  });
  const configured = await ready(id);
  assert.equal(configured.port, 18884);
  assert.equal(configured.properties["skin.title"], "MCP acceptance test");
  await imported(id);
  service.restart(id);
  await ready(id);
  await imported(id);
  service.redeploy(id, false);
  const redeployed = await ready(id);
  assert.equal(redeployed.port, 18884);
  assert.equal(redeployed.properties["skin.title"], "MCP acceptance test");
  console.log("Redeploy preserved:", await imported(id));
} finally {
  if (id) {
    service.destroy(id, true);
    await service.idle(id);
    assert.equal(
      service.status(id).phase,
      "stopped",
      "Smoke deployment cleanup failed",
    );
  }
  await service.close();
}

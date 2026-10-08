import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { Deployments } from "../src/deployments";

// Reuse built images and schema, never the template's volumes or database.
const service = new Deployments();
await service.initialize();
const templateId = process.env.CBIO_MCP_SMOKE_TEMPLATE;
if (!templateId)
  throw new Error("Set CBIO_MCP_SMOKE_TEMPLATE to a built deployment ID");
const template = service.status(templateId);
assert.ok(template.importerImage, "Template needs a built importer image");
const id = `cbio-mcp-${randomBytes(6).toString("hex")}`;
const directory = join(service.root, id);
const { url: _url, busy: _busy, ...savedTemplate } = template;
const inputs = await mkdtemp(join(tmpdir(), "cbio-delete-smoke-"));
const ids = ["delete_first", "delete_second", "delete_keep"];
const studiesSchema = z.array(
  z.object({ studyId: z.string(), allSampleCount: z.number() }),
);
async function ready() {
  await service.idle(id);
  const state = service.status(id);
  assert.equal(
    state.phase,
    "ready",
    `${state.error}\n${await service.logs(id)}`,
  );
}
async function studies() {
  const response = await service.api(id, {
    path: "/api/studies",
    query: { projection: "SUMMARY" },
  });
  assert.equal(response.status, 200);
  return studiesSchema
    .parse(response.body)
    .sort((a, b) => a.studyId.localeCompare(b.studyId));
}
try {
  await mkdir(directory);
  await cp(
    join(service.root, templateId, "runtime"),
    join(directory, "runtime"),
    { recursive: true },
  );
  await writeFile(
    join(directory, "state.json"),
    JSON.stringify({
      ...savedTemplate,
      id,
      port: 18886,
      password: randomBytes(24).toString("hex"),
      phase: "stopped",
      operation: "smoke setup",
    }),
    { mode: 0o600 },
  );
  await service.initialize();
  service.configure(id, {});
  await ready();
  for (const study of ids) {
    const path = join(inputs, study);
    await mkdir(path);
    await writeFile(
      join(path, "meta_study.txt"),
      `type_of_cancer: brca\ncancer_study_identifier: ${study}\nname: ${study}\ndescription: Disposable deletion test\nadd_global_case_list: true\n`,
    );
    for (const [kind, type] of [
      ["sample", "SAMPLE"],
      ["patient", "PATIENT"],
    ] as const) {
      await writeFile(
        join(path, `meta_clinical_${kind}.txt`),
        `cancer_study_identifier: ${study}\ngenetic_alteration_type: CLINICAL\ndatatype: ${type}_ATTRIBUTES\ndata_filename: data_clinical_${kind}.txt\n`,
      );
    }
    await writeFile(
      join(path, "data_clinical_patient.txt"),
      "#Patient Identifier\tSex\n#Patient identifier\tSex\n#STRING\tSTRING\n#1\t1\nPATIENT_ID\tSEX\nP1\tMale\nP2\tFemale\n",
    );
    await writeFile(
      join(path, "data_clinical_sample.txt"),
      "#Patient Identifier\tSample Identifier\tSubtype\n#Patient identifier\tSample identifier\tSubtype\n#STRING\tSTRING\tSTRING\n#1\t1\t1\nPATIENT_ID\tSAMPLE_ID\tSUBTYPE\nP1\tS1\tA\nP2\tS2\tB\n",
    );
  }
  console.log("Disposable deployment", id);
  await service.importStudies({
    id,
    studies: ids.map((study) => join(inputs, study)),
    overrideWarnings: true,
  });
  await ready();
  const before = await studies();
  assert.deepEqual(
    before.map((study) => study.studyId),
    ids.toSorted(),
  );
  assert.ok(before.every((study) => study.allSampleCount === 2));
  service.refreshDerivedTables(id);
  await ready();
  assert.deepEqual(
    await studies(),
    before,
    "Standalone refresh must preserve studies",
  );
  await assert.rejects(
    service.deleteStudies({ id, studyIds: [ids[0] ?? "", "missing"] }),
    /Unknown study/,
  );
  assert.deepEqual(
    await studies(),
    before,
    "Invalid batches must not delete anything",
  );
  await service.deleteStudies({ id, studyIds: ids.slice(0, 2) });
  await ready();
  assert.deepEqual(
    await studies(),
    before.filter((study) => study.studyId === "delete_keep"),
  );
  await service.deleteStudies({ id, studyIds: ["delete_keep"] });
  await ready();
  assert.deepEqual(await studies(), [], "Deleting the last study must work");
  console.log(
    "PASS: batch deletion, retained-study sample counts, standalone refresh, invalid batch, and last-study deletion",
  );
} finally {
  if (service.list().some((state) => state.id === id)) {
    service.destroy(id, true);
    await service.idle(id);
    assert.equal(
      service.status(id).phase,
      "stopped",
      "Disposable deployment cleanup failed",
    );
  }
  await service.close();
  await rm(inputs, { recursive: true, force: true });
}

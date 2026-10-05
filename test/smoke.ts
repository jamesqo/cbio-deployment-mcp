import { Deployments } from "../src/deployments";
const service = new Deployments();
await service.initialize();
let id: string | undefined;
try {
  const reuse = process.env.CBIO_MCP_SMOKE_REUSE;
  const state = reuse
    ? service.redeploy(reuse, false)
    : await service.deploy({
        cbioportal: {
          kind: "local",
          path:
            process.env.CBIO_MCP_BACKEND_CLONE ?? "/home/james/work/cbioportal",
        },
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
  await service.idle(id);
  console.log(service.status(id));
  if (service.status(id).phase !== "ready")
    throw new Error(await service.logs(id));
  const before = await service.api(id, { path: "/api/studies" });
  console.log("Studies before import:", before);
  await service.importStudies({
    id,
    studies: ["/home/james/work/cbioportal/test/test_data/study_es_0"],
    genePanels: [
      "/home/james/work/cbioportal/test/test_data/study_es_0/data_gene_panel_testpanel1.txt",
      "/home/james/work/cbioportal/test/test_data/study_es_0/data_gene_panel_testpanel2.txt",
    ],
    overrideWarnings: true,
  });
  await service.idle(id);
  if (service.status(id).phase !== "ready")
    throw new Error(await service.logs(id));
  console.log(
    "Studies after import:",
    await fetch("http://127.0.0.1:18883/api/studies").then((response) =>
      response.json(),
    ),
  );
  await service.redeploy(id, false);
  await service.idle(id);
  if (service.status(id).phase !== "ready")
    throw new Error(await service.logs(id));
  console.log(
    "Redeploy preserved studies:",
    await fetch("http://127.0.0.1:18883/api/studies").then((response) =>
      response.json(),
    ),
  );
} finally {
  if (id) {
    service.destroy(id, true);
    await service.idle(id);
  }
  await service.close();
}

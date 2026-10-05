import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { apiSchema } from "./api";
import { z } from "zod/v4";
import {
  Deployments,
  deploySchema,
  identifierSchema,
  importSchema,
  propertySchema,
} from "./deployments";

export function createMcpServer(deployments: Deployments) {
  const server = new McpServer({
    name: "cbio-deployment-mcp",
    version: "0.1.0",
  });
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  function tool<T extends z.ZodObject>(
    name: string,
    description: string,
    inputSchema: T,
    execute: (
      input: z.output<T>,
      context: ServerContext,
    ) => unknown | Promise<unknown>,
  ) {
    server.registerTool(
      name,
      { description, inputSchema: z.object(inputSchema.shape).strict() },
      async (input, context) => {
        try {
          return result(await execute(inputSchema.parse(input), context));
        } catch (error: unknown) {
          return {
            ...result({
              error:
                error instanceof Error ? error.message : "Operation failed",
            }),
            isError: true,
          };
        }
      },
    );
  }
  tool(
    "deploy",
    "Build cBioPortal sources and start an isolated localhost Docker deployment. Returns immediately; poll status and logs for readiness. Core source selects the importer when importing studies.",
    deploySchema,
    (input) => deployments.deploy(input),
  );
  tool(
    "list_deployments",
    "List this MCP’s deployments, URLs and operation states.",
    z.object({}),
    () => deployments.list(),
  );
  tool(
    "status",
    "Get build/import progress and source revisions. Ready means /api/studies responded successfully.",
    identifierSchema,
    ({ id }) => deployments.status(id),
  );
  tool(
    "logs",
    "Read bounded build/import logs or a service’s Docker logs.",
    identifierSchema.extend({
      service: z.enum(["app", "database", "session", "mongo"]).optional(),
      lines: z.number().int().min(1).max(1000).default(100),
    }),
    ({ id, service, lines }) => deployments.logs(id, service, lines),
  );
  tool(
    "configure",
    "Update application properties or localhost port, then recreate the backend. Database connection and credentials stay managed and private.",
    identifierSchema.extend({
      port: z.number().int().min(1024).max(65535).optional(),
      properties: propertySchema.optional(),
    }),
    ({ id, ...patch }) => deployments.configure(id, patch),
  );
  tool(
    "restart",
    "Restart the backend and wait for readiness, preserving its database.",
    identifierSchema,
    ({ id }) => deployments.restart(id),
  );
  tool(
    "redeploy",
    "Rebuild the same saved source snapshot by default; refreshRefs fetches current branches/PRs or resnapshots the local checkout. Preserve data, port and properties.",
    identifierSchema.extend({ refreshRefs: z.boolean().default(false) }),
    ({ id, refreshRefs }) => deployments.redeploy(id, refreshRefs),
  );
  tool(
    "import_studies",
    "Import one or more local study directories into this deployment using its core importer. Copies inputs, imports sequentially, rebuilds derived tables and restarts the backend. Imports are not transactional; inspect logs if a later study fails.",
    importSchema.extend({ waitForCompletion: z.boolean().default(false) }),
    async ({ waitForCompletion, ...input }, context) => {
      const started = await deployments.importStudies(input);
      if (!waitForCompletion) return started;
      const cancel = () => deployments.cancel(started.id);
      if (context.mcpReq.signal.aborted) cancel();
      context.mcpReq.signal.addEventListener("abort", cancel, { once: true });
      let lastProgress = -1;
      try {
        while (deployments.status(started.id).busy) {
          context.mcpReq.signal.throwIfAborted();
          const progress = deployments.status(started.id).progress;
          const token = context.mcpReq._meta?.progressToken;
          if (
            progress &&
            progress.completed > lastProgress &&
            (typeof token === "number" || typeof token === "string")
          ) {
            await context.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress: progress.completed,
                total: progress.total,
                message: progress.stage,
              },
            });
          }
          if (progress)
            lastProgress = Math.max(lastProgress, progress.completed);
          await Bun.sleep(1000);
        }
        const state = deployments.status(started.id);
        const token = context.mcpReq._meta?.progressToken;
        if (
          state.progress &&
          state.progress.completed > lastProgress &&
          (typeof token === "number" || typeof token === "string")
        )
          await context.mcpReq.notify({
            method: "notifications/progress",
            params: {
              progressToken: token,
              progress: state.progress.completed,
              total: state.progress.total,
              message: state.progress.stage,
            },
          });
        if (state.phase === "failed")
          throw new Error(`${state.id}: ${state.error}`);
        return state;
      } finally {
        context.mcpReq.signal.removeEventListener("abort", cancel);
      }
    },
  );
  tool(
    "api_request",
    "Call this deployment’s /api/... endpoints for API acceptance checks. Returns HTTP status and bounded JSON/text. Supports query parameters and JSON request bodies; redirects are not followed.",
    apiSchema.safeExtend({ id: identifierSchema.shape.id }),
    ({ id, ...input }, context) =>
      deployments.api(id, input, context.mcpReq.signal),
  );
  tool(
    "destroy",
    "Stop this deployment. deleteData=true also removes its dedicated database and session volumes.",
    identifierSchema.extend({ deleteData: z.boolean().default(false) }),
    ({ id, deleteData }) => deployments.destroy(id, deleteData),
  );
  server.server.onclose = () => {
    deployments
      .close()
      .catch((error: unknown) =>
        console.error(
          error instanceof Error ? error.message : "Shutdown failed",
        ),
      );
  };
  return server;
}

if (import.meta.main) {
  const deployments = new Deployments();
  await deployments.initialize();
  const server = createMcpServer(deployments);
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await deployments.close();
    await server.close();
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      shutdown().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
  await server.connect(new StdioServerTransport());
}

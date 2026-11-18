import { createHash } from "node:crypto";
import { relative, isAbsolute, sep } from "node:path";
import { properties } from "./compose";
import type { RuntimeContext, ImporterTask, Service } from "./runtime";

export type KubernetesStorage = {
  workspaceClass: string;
  databaseClass: string;
  workspaceSize?: string;
  databaseSize?: string;
  nodeSelector?: Record<string, string>;
};
const managed = { "app.kubernetes.io/managed-by": "cbio-deployment-mcp" };
export function namespaceResource(context: RuntimeContext) {
  if (!/^cbio-mcp-[a-f0-9]{12}$/.test(context.state.id))
    throw new Error("Invalid deployment namespace");
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: context.state.id, labels: managed },
  };
}
function metadata(context: RuntimeContext, name: string) {
  return {
    name,
    namespace: namespaceResource(context).metadata.name,
    labels: { ...managed, "app.kubernetes.io/name": name },
  };
}
function claim(
  context: RuntimeContext,
  name: string,
  storageClassName: string,
  size: string,
  access: string,
) {
  if (!storageClassName)
    throw new Error("Explicit Kubernetes storage classes are required");
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: metadata(context, name),
    spec: {
      accessModes: [access],
      storageClassName,
      resources: { requests: { storage: size } },
    },
  };
}
const workspaceVolume = {
  name: "workspace",
  persistentVolumeClaim: { claimName: "workspace" },
};
const configurationVolume = {
  name: "configuration",
  secret: { secretName: "configuration" },
};
const runtimeMount = {
  name: "workspace",
  mountPath: "/runtime",
  subPath: "runtime",
  readOnly: true,
};
const configurationMount = {
  name: "configuration",
  mountPath: "/runtime/application.properties",
  subPath: "application.properties",
  readOnly: true,
};
function podSpec(
  storage: KubernetesStorage,
  containers: unknown[],
  volumes: unknown[],
) {
  return {
    automountServiceAccountToken: false,
    nodeSelector: storage.nodeSelector,
    containers,
    volumes,
  };
}
function deployment(
  context: RuntimeContext,
  name: string,
  spec: ReturnType<typeof podSpec>,
  revision?: string,
) {
  const meta = metadata(context, name);
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: meta,
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: meta.labels },
      template: {
        metadata: {
          labels: meta.labels,
          annotations: revision
            ? { "cbio-mcp/configuration": revision }
            : undefined,
        },
        spec,
      },
    },
  };
}
function resources(memory: string, cpu = "100m") {
  return { requests: { cpu, memory }, limits: { memory } };
}
export function workspaceResources(
  context: RuntimeContext,
  storage: KubernetesStorage,
) {
  return [
    claim(
      context,
      "workspace",
      storage.workspaceClass,
      storage.workspaceSize ?? "20Gi",
      "ReadWriteMany",
    ),
    claim(
      context,
      "database",
      storage.databaseClass,
      storage.databaseSize ?? "20Gi",
      "ReadWriteOnce",
    ),
    claim(context, "sessions", storage.databaseClass, "5Gi", "ReadWriteOnce"),
    deployment(
      context,
      "workspace",
      podSpec(
        storage,
        [
          {
            name: "workspace",
            image: "busybox:1.37.0",
            command: [
              "sh",
              "-c",
              "mkdir -p /workspace/runtime /workspace/tasks; exec sleep infinity",
            ],
            resources: resources("128Mi"),
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            readinessProbe: {
              exec: { command: ["test", "-d", "/workspace/runtime"] },
            },
          },
        ],
        [workspaceVolume],
      ),
    ),
  ];
}
export function configurationResource(context: RuntimeContext) {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: metadata(context, "configuration"),
    type: "Opaque",
    stringData: {
      "application.properties": properties(context.state),
      password: context.state.password,
    },
  };
}
export function serviceResources(context: RuntimeContext) {
  return Object.entries({
    app: [8080],
    database: [8123, 9000],
    mongo: [27017],
    session: [5001],
  }).map(([name, ports]) => ({
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata(context, name),
    spec: {
      type: "ClusterIP",
      selector: metadata(context, name).labels,
      ports: ports.map((port) => ({
        name: `tcp-${port}`,
        port,
        targetPort: port,
      })),
    },
  }));
}
export function serviceDeployment(
  context: RuntimeContext,
  storage: KubernetesStorage,
  service: Service,
  image: string,
) {
  const state = context.state;
  const revision = createHash("sha256").update(properties(state)).digest("hex");
  const env = (values: Record<string, string>) =>
    Object.entries(values).map(([name, value]) => ({ name, value }));
  const databaseCheck = {
    exec: {
      command: [
        "sh",
        "-c",
        'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --query "SELECT count() FROM type_of_cancer"',
      ],
    },
    periodSeconds: 5,
    timeoutSeconds: 5,
  };
  switch (service) {
    case "database":
      return deployment(
        context,
        service,
        podSpec(
          storage,
          [
            {
              name: service,
              image: "clickhouse/clickhouse-server:25.3",
              resources: resources("3Gi"),
              env: [
                ...env({
                  CLICKHOUSE_DB: state.database,
                  CLICKHOUSE_USER: "cbio_user",
                  CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
                }),
                {
                  name: "CLICKHOUSE_PASSWORD",
                  valueFrom: {
                    secretKeyRef: { name: "configuration", key: "password" },
                  },
                },
              ],
              volumeMounts: [
                { name: "data", mountPath: "/var/lib/clickhouse" },
                runtimeMount,
                {
                  name: "workspace",
                  mountPath: "/docker-entrypoint-initdb.d/001_init.sh",
                  subPath: "runtime/init.sh",
                  readOnly: true,
                },
              ],
              startupProbe: { ...databaseCheck, failureThreshold: 120 },
              readinessProbe: databaseCheck,
            },
          ],
          [
            workspaceVolume,
            { name: "data", persistentVolumeClaim: { claimName: "database" } },
          ],
        ),
        revision,
      );
    case "mongo":
      return deployment(
        context,
        service,
        podSpec(
          storage,
          [
            {
              name: service,
              image: "mongo:4.2",
              resources: resources("512Mi"),
              volumeMounts: [{ name: "data", mountPath: "/data/db" }],
              readinessProbe: { tcpSocket: { port: 27017 } },
            },
          ],
          [{ name: "data", persistentVolumeClaim: { claimName: "sessions" } }],
        ),
      );
    case "session":
      return deployment(
        context,
        service,
        podSpec(
          storage,
          [
            {
              name: service,
              image: "cbioportal/session-service:0.6.4",
              resources: resources("1Gi"),
              env: env({
                SERVER_PORT: "5001",
                JAVA_OPTS:
                  "-Dspring.data.mongodb.uri=mongodb://mongo:27017/session-service",
              }),
              readinessProbe: { tcpSocket: { port: 5001 }, periodSeconds: 5 },
            },
          ],
          [],
        ),
      );
    case "app":
      return deployment(
        context,
        service,
        podSpec(
          storage,
          [
            {
              name: service,
              image,
              imagePullPolicy: "Always",
              resources: resources("3Gi"),
              env: env({
                JAVA_OPTS: "-Xms256m -Xmx2g",
                WEBAPP_OPTS:
                  "--spring.config.location=file:/config/application.properties --server.port=8080",
              }),
              volumeMounts: [
                {
                  ...configurationMount,
                  mountPath: "/config/application.properties",
                },
              ],
              startupProbe: {
                httpGet: { path: "/api/studies", port: 8080 },
                periodSeconds: 5,
                failureThreshold: 120,
              },
              readinessProbe: {
                httpGet: { path: "/api/studies", port: 8080 },
                periodSeconds: 5,
              },
            },
          ],
          [configurationVolume],
        ),
        revision,
      );
  }
}
export function workspacePath(context: RuntimeContext, local: string) {
  const path = relative(context.directory, local);
  if (!path || isAbsolute(path) || path.split(sep).includes(".."))
    throw new Error("Runtime files must be inside their deployment directory");
  return path.split(sep).join("/");
}
export function importerJob(
  context: RuntimeContext,
  storage: KubernetesStorage,
  task: ImporterTask,
  image: string,
  name: string,
) {
  if (!/^task-[a-f0-9]{12}$/.test(name))
    throw new Error("Invalid importer job name");
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: metadata(context, name),
    spec: {
      // Imports/deletions are not transactional; automatic retries could repeat writes.
      backoffLimit: 0,
      activeDeadlineSeconds: 2700,
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels: metadata(context, name).labels },
        spec: {
          ...podSpec(
            storage,
            [
              {
                name: "importer",
                image,
                imagePullPolicy: "Always",
                command: ["sh", task.script, ...task.args],
                resources: resources("4Gi"),
                env: [
                  { name: "PORTAL_HOME", value: "/runtime" },
                  { name: "PYTHONUNBUFFERED", value: "1" },
                  {
                    name: "IMPORT_GENE_PANELS",
                    value: task.importGenePanels ? "1" : "0",
                  },
                ],
                volumeMounts: [
                  runtimeMount,
                  configurationMount,
                  ...(task.study
                    ? [
                        {
                          name: "workspace",
                          mountPath: "/study",
                          subPath: workspacePath(context, task.study),
                        },
                      ]
                    : []),
                  ...(task.reference
                    ? [
                        {
                          name: "workspace",
                          mountPath: "/reference",
                          subPath: workspacePath(context, task.reference),
                          readOnly: true,
                        },
                      ]
                    : []),
                ],
              },
            ],
            [workspaceVolume, configurationVolume],
          ),
          restartPolicy: "Never",
        },
      },
    },
  };
}

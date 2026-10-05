import type { Deployment } from "./deployments";

export function properties(deployment: Deployment): string {
  const fixed = {
    "spring.datasource.url": `jdbc:ch://database:8123/${deployment.database}`,
    "spring.datasource.username": "cbio_user",
    "spring.datasource.password": deployment.password,
    "spring.datasource.driver-class-name":
      "com.clickhouse.jdbc.ClickHouseDriver",
    clickhouse_mode: "true",
    authenticate: "false",
    "server.forward-headers-strategy": "framework",
    "spring.profiles.active": "clickhouse",
    "session.service.url": "http://session:5001/api/sessions/my_portal/",
  };
  const escape = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return (
    Object.entries({ ...deployment.properties, ...fixed })
      .map(([key, value]) => `${key}=${escape(value)}`)
      .join("\n") + "\n"
  );
}

export function compose(deployment: Deployment, directory: string) {
  const runtime = `${directory}/runtime`;
  return {
    name: deployment.id,
    services: {
      database: {
        image: "clickhouse/clickhouse-server:25.3",
        environment: {
          CLICKHOUSE_DB: deployment.database,
          CLICKHOUSE_USER: "cbio_user",
          CLICKHOUSE_PASSWORD: deployment.password,
          CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
        },
        volumes: [
          "database:/var/lib/clickhouse",
          `${runtime}:/runtime:ro`,
          `${runtime}/init.sh:/docker-entrypoint-initdb.d/001_init.sh:ro`,
        ],
        healthcheck: {
          test: [
            "CMD-SHELL",
            'clickhouse-client --user "$$CLICKHOUSE_USER" --password "$$CLICKHOUSE_PASSWORD" --database "$$CLICKHOUSE_DB" --query "SELECT count() FROM type_of_cancer"',
          ],
          interval: "5s",
          timeout: "5s",
          retries: 60,
        },
      },
      mongo: { image: "mongo:4.2", volumes: ["sessions:/data/db"] },
      session: {
        image: "cbioportal/session-service:0.6.4",
        environment: {
          SERVER_PORT: "5001",
          JAVA_OPTS:
            "-Dspring.data.mongodb.uri=mongodb://mongo:27017/session-service",
        },
        depends_on: ["mongo"],
      },
      app: {
        image: deployment.image,
        ports: [`127.0.0.1:${deployment.port}:8080`],
        volumes: [
          `${runtime}/application.properties:/config/application.properties:ro`,
        ],
        environment: {
          JAVA_OPTS: "-Xms256m -Xmx2g",
          WEBAPP_OPTS:
            "--spring.config.location=file:/config/application.properties --server.port=8080",
        },
        depends_on: {
          database: { condition: "service_healthy" },
          session: { condition: "service_started" },
        },
      },
    },
    volumes: { database: {}, sessions: {} },
    networks: { default: { internal: false } },
  };
}

export const initScript = `#!/bin/sh
set -eu
clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --multiquery < /runtime/schema.sql
gunzip -c /runtime/seed.sql.gz | clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" --multiquery
`;

export const importScript = `set -eu
jarfile=$(find / -maxdepth 1 -name 'core-*.jar' -print -quit)
test -n "$jarfile"
cd /runtime
jar uf "$jarfile" application.properties
if [ "$IMPORT_GENE_PANELS" = "1" ]; then
  for panel in /reference/*.txt; do
    [ -f "$panel" ] || continue
    java -Xmx2g -cp "$jarfile" org.mskcc.cbio.portal.scripts.ImportGenePanel --data "$panel" --noprogress
  done
fi
if grep -q -- '--no-derive-tables' /scripts/importer/metaImport.py; then
  set -- --no-derive-tables "$@"
fi
python3 /scripts/importer/metaImport.py -s /study -n -jar "$jarfile" --java_opts=-Xmx2g "$@"
`;

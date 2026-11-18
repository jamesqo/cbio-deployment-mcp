import { z } from "zod/v4";
import { DockerRuntime, type DeploymentRuntime } from "./runtime";
import { KubernetesRuntime } from "./kubernetes-runtime";

export function configuredRuntime(env = process.env): DeploymentRuntime {
  const mode = env.CBIO_RUNTIME ?? "docker";
  if (mode === "docker") return new DockerRuntime();
  if (mode !== "kubernetes")
    throw new Error("CBIO_RUNTIME must be docker or kubernetes");
  const required = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is required for Kubernetes`);
    return value;
  };
  return new KubernetesRuntime({
    context: required("CBIO_KUBE_CONTEXT"),
    imageRepository: required("CBIO_IMAGE_REPOSITORY"),
    buildkitAddress: required("CBIO_BUILDKIT_ADDR"),
    workspaceClass: required("CBIO_KUBE_WORKSPACE_CLASS"),
    databaseClass: required("CBIO_KUBE_DATABASE_CLASS"),
    nodeSelector: env.CBIO_KUBE_NODE_SELECTOR
      ? z
          .record(z.string(), z.string())
          .parse(JSON.parse(env.CBIO_KUBE_NODE_SELECTOR))
      : undefined,
  });
}

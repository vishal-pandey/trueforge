import { z } from 'zod';

export interface KubernetesSandboxConfig {
  namespace: string;
  image: string;
  idleTtlMinutes: number;
  execTimeoutMs: number;
  runtimeClassName: string | undefined;
}

const positiveInt = (name: string) =>
  z.coerce
    .number({ error: `${name} must be a positive integer` })
    .int(`${name} must be a positive integer`)
    .positive(`${name} must be a positive integer`);

const Schema = z.object({
  KUBERNETES_SANDBOX_NAMESPACE: z.string().min(1).default('trueforge-sandboxes'),
  KUBERNETES_SANDBOX_IMAGE: z
    .string({ error: 'KUBERNETES_SANDBOX_IMAGE is required when KUBERNETES_SANDBOX_ENABLED=true' })
    .min(1, 'KUBERNETES_SANDBOX_IMAGE is required when KUBERNETES_SANDBOX_ENABLED=true'),
  KUBERNETES_SANDBOX_IDLE_TTL_MINUTES: positiveInt('KUBERNETES_SANDBOX_IDLE_TTL_MINUTES').default(60),
  KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS: positiveInt('KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS').default(60_000),
  KUBERNETES_SANDBOX_RUNTIME_CLASS: z.string().min(1).optional(),
});

/** Server-managed Kubernetes sandbox settings; undefined unless KUBERNETES_SANDBOX_ENABLED=true. */
export function readKubernetesSandboxConfig(env: NodeJS.ProcessEnv = process.env): KubernetesSandboxConfig | undefined {
  if (env['KUBERNETES_SANDBOX_ENABLED']?.trim().toLowerCase() !== 'true') {
    return undefined;
  }
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid Kubernetes sandbox configuration: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  }
  const c = parsed.data;
  return {
    namespace: c.KUBERNETES_SANDBOX_NAMESPACE,
    image: c.KUBERNETES_SANDBOX_IMAGE,
    idleTtlMinutes: c.KUBERNETES_SANDBOX_IDLE_TTL_MINUTES,
    execTimeoutMs: c.KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS,
    runtimeClassName: c.KUBERNETES_SANDBOX_RUNTIME_CLASS,
  };
}

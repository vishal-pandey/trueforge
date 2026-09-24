import { HTTPException } from 'hono/http-exception';
import type {
  ISandboxProviderStore,
  SandboxProviderRecord,
  UpdateSandboxStatusInput,
  UpsertSandboxProviderInput,
} from '../../db/sandboxProviderStore';
import type { KubernetesSandboxConfig } from './kubernetesSandboxConfig';

export const KUBERNETES_MANAGED_MESSAGE =
  'The sandbox provider is managed by server configuration (Kubernetes); change it in the deployment, not here.';

function managed(): never {
  throw new HTTPException(409, { message: KUBERNETES_MANAGED_MESSAGE });
}

/** Env-backed shared Kubernetes sandbox for every tenant; settings writes are rejected. */
export class KubernetesSandboxProviderStore<TTransaction = never> implements ISandboxProviderStore<TTransaction> {
  constructor(private readonly config: KubernetesSandboxConfig) {}

  private record(tenantId: string): SandboxProviderRecord {
    const now = new Date().toISOString();
    return {
      tenant_id: tenantId,
      manifest: {
        type: 'kubernetes',
        namespace: this.config.namespace,
        image: this.config.image,
        exec_timeout_ms: this.config.execTimeoutMs,
        idle_ttl_minutes: this.config.idleTtlMinutes,
        runtime_class_name: this.config.runtimeClassName ?? null,
      },
      status: 'ready',
      status_reason: null,
      build_metadata: { image_uri: this.config.image },
      created_at: now,
      updated_at: now,
    };
  }

  getSandboxProvider(tenantId: string, transaction?: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void transaction;
    return Promise.resolve(this.record(tenantId));
  }

  getSandboxProviderForUpdate(tenantId: string, transaction: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void tenantId;
    void transaction;
    return Promise.reject(new HTTPException(409, { message: KUBERNETES_MANAGED_MESSAGE }));
  }

  upsertSandboxProvider(input: UpsertSandboxProviderInput, transaction?: TTransaction): Promise<SandboxProviderRecord> {
    void input;
    void transaction;
    return Promise.resolve().then(managed);
  }

  updateSandboxStatus(
    input: UpdateSandboxStatusInput,
    transaction?: TTransaction,
  ): Promise<SandboxProviderRecord | undefined> {
    void transaction;
    return Promise.resolve(this.record(input.tenant_id));
  }
}

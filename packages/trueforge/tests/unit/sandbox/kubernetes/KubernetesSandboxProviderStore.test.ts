import { HTTPException } from 'hono/http-exception';
import { KubernetesSandboxProviderStore } from '../../../../src/sandbox/kubernetes/KubernetesSandboxProviderStore';

const config = {
  namespace: 'trueforge-sandboxes',
  image: 'ghcr.io/x/sb:v1',
  idleTtlMinutes: 60,
  execTimeoutMs: 60_000,
  runtimeClassName: undefined,
};

describe('KubernetesSandboxProviderStore', () => {
  it('synthesizes a ready kubernetes record for any tenant', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    const record = await store.getSandboxProvider('default');
    expect(record).toMatchObject({
      tenant_id: 'default',
      manifest: {
        type: 'kubernetes',
        namespace: 'trueforge-sandboxes',
        image: 'ghcr.io/x/sb:v1',
        exec_timeout_ms: 60_000,
        idle_ttl_minutes: 60,
        runtime_class_name: null,
      },
      status: 'ready',
      status_reason: null,
      build_metadata: { image_uri: 'ghcr.io/x/sb:v1' },
    });
  });

  it('rejects writes as server-managed (409)', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    await expect(store.getSandboxProviderForUpdate('default', undefined as never)).rejects.toMatchObject({
      status: 409,
    });
    await expect(store.upsertSandboxProvider({} as never)).rejects.toBeInstanceOf(HTTPException);
  });

  it('status updates are a no-op returning the synthesized record', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    const updated = await store.updateSandboxStatus({
      tenant_id: 'default',
      status: 'failed',
      status_reason: 'x',
      build_metadata: null,
    });
    expect(updated?.status).toBe('ready');
  });
});

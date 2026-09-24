import { createLogger } from 'winston';
import { createSandboxProvidersRouter } from '../../../src/apis/sandboxProviders';
import { KubernetesSandboxProviderStore } from '../../../src/sandbox/kubernetes/KubernetesSandboxProviderStore';

const store = new KubernetesSandboxProviderStore({
  namespace: 'trueforge-sandboxes',
  image: 'ghcr.io/x/sb:v1',
  idleTtlMinutes: 60,
  execTimeoutMs: 60_000,
  runtimeClassName: undefined,
});

function router() {
  return createSandboxProvidersRouter({
    resolveSandboxProviderStore: () => store,
    withTransaction: async fn => fn(undefined as never),
    logger: createLogger({ silent: true }),
    resolveRequestContext: () => ({ tenant_id: 'default' }) as never,
  });
}

describe('sandbox providers — kubernetes managed', () => {
  it('GET /managed describes the managed provider', async () => {
    const res = await router().request('/managed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: 'trueforge-sandboxes', status: 'ready' },
    });
  });

  it('GET / stays 404 (settings form is Daytona-only)', async () => {
    const res = await router().request('/');
    expect(res.status).toBe(404);
  });

  it('PUT / is rejected with 409', async () => {
    const res = await router().request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'daytona',
          auth: { api_key: 'k' },
          exec_timeout_ms: 1,
          auto_stop_interval_in_minutes: 1,
          auto_archive_interval_in_minutes: 1,
          auto_delete_interval_in_minutes: 1,
        },
      }),
    });
    expect(res.status).toBe(409);
  });

  it('GET /managed is 404 for non-managed stores', async () => {
    const r = createSandboxProvidersRouter({
      resolveSandboxProviderStore: () => ({ getSandboxProvider: () => Promise.resolve(undefined) }) as never,
      withTransaction: async fn => fn(undefined as never),
      logger: createLogger({ silent: true }),
      resolveRequestContext: () => ({ tenant_id: 'default' }) as never,
    });
    expect((await r.request('/managed')).status).toBe(404);
  });
});

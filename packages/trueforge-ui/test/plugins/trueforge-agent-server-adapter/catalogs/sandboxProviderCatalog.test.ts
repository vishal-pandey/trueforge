import { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  configFromHarness,
  createSandboxProviderCatalog,
  filterUiSandboxProviders,
  toHarnessManifest,
  toUiCatalogEntry,
  toUiSandboxProvider,
  toUiSandboxProviderListEntry,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/sandboxProviderCatalog.js';

describe('sandboxProviderCatalog mappers', () => {
  const harnessCatalog = {
    type: 'daytona' as const,
    execTimeoutMs: 60000,
    autoStopIntervalInMinutes: 5,
    autoArchiveIntervalInMinutes: 60,
    autoDeleteIntervalInMinutes: 7200,
  };

  const harnessConfigured = {
    ...harnessCatalog,
    auth: { apiKey: 'dtn_secret' },
  };

  function configuredResponse({
    status,
    statusReason,
  }: {
    status: TrueForgeApi.SandboxBuildStatus;
    statusReason: string | null;
  }): TrueForgeApi.GetSandboxProviderResponse['data'] {
    return {
      manifest: harnessConfigured,
      status,
      statusReason,
    };
  }

  // Snapshot/image is release-owned now; mappers emit an empty snapshotName only to satisfy
  // the external SandboxProviderConfig type, and toHarnessManifest omits it entirely.
  it('stamps catalog identity from type and strips auth', () => {
    assert.deepEqual(toUiCatalogEntry(harnessCatalog), {
      id: 'daytona',
      name: 'Daytona',
      type: 'daytona',
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
  });

  it('maps configured provider without embedding apiKey', () => {
    assert.deepEqual(toUiSandboxProvider(harnessConfigured), {
      id: 'daytona',
      name: 'Daytona',
      catalogId: 'daytona',
      isConnected: true,
      execTimeoutMs: 60000,
      autoStopIntervalInMinutes: 5,
      autoArchiveIntervalInMinutes: 60,
      autoDeleteIntervalInMinutes: 7200,
    });
    assert.equal('auth' in toUiSandboxProvider(harnessConfigured), false);
    assert.equal('apiKey' in toUiSandboxProvider(harnessConfigured), false);
  });

  it('wraps configured providers with snapshot sync status', () => {
    for (const status of [
      TrueForgeApi.SandboxBuildStatus.Pending,
      TrueForgeApi.SandboxBuildStatus.Ready,
      TrueForgeApi.SandboxBuildStatus.Failed,
    ]) {
      const statusReason = status === TrueForgeApi.SandboxBuildStatus.Failed ? 'Snapshot build failed' : null;
      const entry = toUiSandboxProviderListEntry(configuredResponse({ status, statusReason }));

      assert.equal(entry.snapshotSyncStatus.status, status);
      assert.deepEqual(entry.data, toUiSandboxProvider(harnessConfigured));
      if (statusReason) {
        assert.equal(entry.snapshotSyncStatus.statusReason, statusReason);
      } else {
        assert.equal('statusReason' in entry.snapshotSyncStatus, false);
      }
    }
  });

  it('filters wrapped providers by provider identity', () => {
    const provider = toUiSandboxProviderListEntry(
      configuredResponse({
        status: TrueForgeApi.SandboxBuildStatus.Ready,
        statusReason: null,
      }),
    );

    assert.deepEqual(filterUiSandboxProviders({ providers: [provider], query: ' DAYT ' }), [provider]);
    assert.deepEqual(filterUiSandboxProviders({ providers: [provider], query: 'missing' }), []);
  });

  it('round-trips config fields into harness upsert body without a snapshot name', () => {
    assert.deepEqual(
      toHarnessManifest({
        type: 'daytona',
        apiKey: 'dtn_secret',
        ...configFromHarness(harnessCatalog),
      }),
      harnessConfigured,
    );
  });

  it('rejects unsupported sandbox provider types', () => {
    assert.throws(
      () =>
        toHarnessManifest({
          type: 'other',
          apiKey: 'x',
          execTimeoutMs: 1,
          autoStopIntervalInMinutes: 1,
          autoArchiveIntervalInMinutes: 1,
          autoDeleteIntervalInMinutes: 1,
        }),
      /Unsupported sandbox provider type/i,
    );
  });
});

describe('managed kubernetes provider', () => {
  const managedBody = {
    data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: 'trueforge-sandboxes', status: 'ready' },
  };

  function http(status: number, body: unknown) {
    const calls: string[] = [];
    return {
      calls,
      baseUrl: 'https://tf.example/',
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch,
    };
  }

  it('lists the managed provider as connected and read-only, and hides the catalog', async () => {
    let sdkCalls = 0;
    const client = {
      settings: { sandboxProviders: { get: async () => (sdkCalls++, {}) } },
      catalogs: { sandboxProviders: { list: async () => (sdkCalls++, { data: [] }) } },
    } as never;
    const h = http(200, managedBody);
    const catalog = createSandboxProviderCatalog(client, h);
    const listed = await catalog.listSandboxProviders();
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0]?.snapshotSyncStatus, { status: 'ready' });
    assert.equal(listed[0]?.data.name, 'Kubernetes (homelab)');
    assert.equal((listed[0]?.data as { managed?: boolean }).managed, true);
    assert.deepEqual(await catalog.getSandboxProviderCatalog(), []);
    assert.equal(sdkCalls, 0);
    assert.equal(h.calls[0], 'https://tf.example/api/v1/settings/sandbox-providers/managed');
  });

  it('falls back to the Daytona flow when /managed is 404', async () => {
    let getCalls = 0;
    const client = {
      settings: {
        sandboxProviders: {
          get: async () => {
            getCalls++;
            throw new TrueForgeApi.NotFoundError({ error: { message: 'No sandbox provider configured' } });
          },
        },
      },
      catalogs: { sandboxProviders: { list: async () => ({ data: [] }) } },
    } as never;
    const catalog = createSandboxProviderCatalog(client, http(404, { error: { message: 'x' } }));
    assert.deepEqual(await catalog.listSandboxProviders(), []);
    assert.equal(getCalls, 1);
  });
});

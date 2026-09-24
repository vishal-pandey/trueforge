/**
 * Maps trueforge-ui sandbox-settings calls onto Harness
 * `/api/v1/settings/sandbox-providers` (singleton upsert, no delete).
 *
 * UI: multi-row providers with `id` / `catalogId` / `name` / flat `apiKey`.
 * Harness: one Daytona provider per tenant; catalog YAML has no name — synthetic
 * identity uses `type` (`daytona`) as id/catalogId and display name `Daytona`.
 */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type {
  SandboxCatalogServer,
  SandboxProviderBase,
  SandboxProviderCatalogEntry,
  SandboxProviderConfig,
  SandboxProviderListEntry,
} from '../../../server/types.js';

/** `managed`: server-configured provider (e.g. Kubernetes) — shown read-only. */
export type UiSandboxProvider = SandboxProviderBase & { managed?: boolean };
export type UiSandboxProviderCatalogEntry = SandboxProviderCatalogEntry;
export type UiSandboxProviderListEntry = SandboxProviderListEntry;

const DAYTONA_TYPE = 'daytona';
const DAYTONA_DISPLAY_NAME = 'Daytona';

function displayNameForType(type: string): string {
  if (type === DAYTONA_TYPE) {
    return DAYTONA_DISPLAY_NAME;
  }
  return type;
}

export function configFromHarness(
  provider: TrueForgeApi.CatalogSandboxProvider | TrueForgeApi.SandboxProviderManifest,
): SandboxProviderConfig {
  return {
    execTimeoutMs: provider.execTimeoutMs,
    autoStopIntervalInMinutes: provider.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: provider.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: provider.autoDeleteIntervalInMinutes,
  };
}

export function toUiCatalogEntry(provider: TrueForgeApi.CatalogSandboxProvider): UiSandboxProviderCatalogEntry {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    type: provider.type,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProvider(provider: TrueForgeApi.SandboxProviderManifest): UiSandboxProvider {
  return {
    id: provider.type,
    name: displayNameForType(provider.type),
    catalogId: provider.type,
    isConnected: true,
    ...configFromHarness(provider),
  };
}

export function toUiSandboxProviderListEntry(
  response: TrueForgeApi.GetSandboxProviderResponse['data'],
): UiSandboxProviderListEntry {
  return {
    data: toUiSandboxProvider(response.manifest),
    snapshotSyncStatus: {
      status: response.status,
      ...(response.statusReason ? { statusReason: response.statusReason } : {}),
    },
  };
}

export function filterUiSandboxProviders({
  providers,
  query,
}: {
  providers: UiSandboxProviderListEntry[];
  query?: string;
}): UiSandboxProviderListEntry[] {
  const normalizedQuery = query?.trim().toLowerCase();
  if (normalizedQuery === undefined || normalizedQuery === '') {
    return providers;
  }
  return providers.filter(
    provider =>
      provider.data.name.toLowerCase().includes(normalizedQuery) ||
      provider.data.id.toLowerCase().includes(normalizedQuery),
  );
}

export function toHarnessManifest(
  req: {
    type: string;
    apiKey: string;
  } & SandboxProviderConfig,
): TrueForgeApi.SandboxProviderManifest {
  if (req.type !== DAYTONA_TYPE) {
    throw new Error(`Unsupported sandbox provider type: ${req.type}`);
  }
  return {
    type: DAYTONA_TYPE,
    execTimeoutMs: req.execTimeoutMs,
    autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
    autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
    autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
    auth: { apiKey: req.apiKey },
  };
}

/** Plain HTTP access for endpoints not in the generated SDK. */
export interface ManagedProviderHttp {
  baseUrl: string;
  fetch: typeof fetch;
  token?: string | undefined;
}

interface ManagedProviderResponse {
  data: { type: string; name: string; namespace: string; status: 'pending' | 'ready' | 'failed' };
}

/** Server-managed provider (e.g. Kubernetes) as a read-only list entry; undefined when settings are tenant-managed. */
export async function fetchManagedSandboxProvider(
  http: ManagedProviderHttp,
): Promise<UiSandboxProviderListEntry | undefined> {
  const base = http.baseUrl.endsWith('/') ? http.baseUrl : `${http.baseUrl}/`;
  const url = new URL('api/v1/settings/sandbox-providers/managed', base).toString();
  const response = await http.fetch(url, {
    credentials: 'include',
    headers: http.token ? { Authorization: `Bearer ${http.token}` } : {},
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Failed to load managed sandbox provider (${String(response.status)})`);
  }
  const body = (await response.json()) as ManagedProviderResponse;
  const provider: UiSandboxProvider = {
    id: body.data.type,
    name: body.data.name,
    catalogId: body.data.type,
    isConnected: true,
    managed: true,
    // No Daytona lifecycle knobs for a server-managed provider.
    execTimeoutMs: 0,
    autoStopIntervalInMinutes: 0,
    autoArchiveIntervalInMinutes: 0,
    autoDeleteIntervalInMinutes: 0,
  };
  return { data: provider, snapshotSyncStatus: { status: body.data.status } };
}

/** Settings sandbox-catalog port for `createTrueFoundryServer`. Delete omitted (no BE route). */
export function createSandboxProviderCatalog(client: TrueForge, http?: ManagedProviderHttp): SandboxCatalogServer {
  async function resolveApiKey(apiKey: string | undefined): Promise<string> {
    const trimmed = apiKey?.trim();
    if (trimmed !== undefined && trimmed !== '') {
      return trimmed;
    }
    const existing = await client.settings.sandboxProviders.get();
    return existing.data.manifest.auth.apiKey;
  }

  return {
    getSandboxProviderCatalog: async () => {
      if (http && (await fetchManagedSandboxProvider(http))) {
        return [];
      }
      const body = await client.catalogs.sandboxProviders.list();
      return body.data.map(toUiCatalogEntry);
    },
    listSandboxProviders: async req => {
      const managed = http ? await fetchManagedSandboxProvider(http) : undefined;
      if (managed) {
        return filterUiSandboxProviders({ providers: [managed], query: req?.query });
      }
      let providers: UiSandboxProviderListEntry[];
      try {
        const body = await client.settings.sandboxProviders.get();
        providers = [toUiSandboxProviderListEntry(body.data)];
      } catch (err) {
        if (err instanceof TrueForgeApi.NotFoundError) {
          providers = [];
        } else {
          throw err;
        }
      }
      return filterUiSandboxProviders({ providers, query: req?.query });
    },
    createSandboxProvider: async req => {
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type: req.type,
          apiKey: req.apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
    updateSandboxProvider: async req => {
      const apiKey = await resolveApiKey(req.apiKey);
      const body = await client.settings.sandboxProviders.createOrUpdate({
        manifest: toHarnessManifest({
          type: DAYTONA_TYPE,
          apiKey,
          execTimeoutMs: req.execTimeoutMs,
          autoStopIntervalInMinutes: req.autoStopIntervalInMinutes,
          autoArchiveIntervalInMinutes: req.autoArchiveIntervalInMinutes,
          autoDeleteIntervalInMinutes: req.autoDeleteIntervalInMinutes,
        }),
      });
      return toUiSandboxProvider(body.data.manifest);
    },
  };
}

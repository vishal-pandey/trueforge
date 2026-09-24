import { DEFAULT_SANDBOX_NATS_WS_PORT } from '../../constants';

export const SANDBOX_API_VERSION = 'agents.x-k8s.io/v1beta1';
export const SANDBOX_CONTAINER_NAME = 'sandbox';
export const SANDBOX_UID = 1000;

export interface SandboxResources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
}

export interface SandboxManifestParams {
  name: string;
  namespace: string;
  tenantName: string;
  image: string;
  shutdownTime: Date;
  runtimeClassName?: string | undefined;
  resources?: SandboxResources | undefined;
}

export interface SandboxManifest {
  apiVersion: typeof SANDBOX_API_VERSION;
  kind: 'Sandbox';
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    shutdownTime: string;
    shutdownPolicy: 'Delete';
    podTemplate: {
      metadata: { labels: Record<string, string> };
      spec: {
        automountServiceAccountToken: false;
        enableServiceLinks: false;
        runtimeClassName?: string;
        securityContext: Record<string, unknown>;
        containers: {
          name: string;
          image: string;
          imagePullPolicy: 'IfNotPresent';
          ports: { name: string; containerPort: number }[];
          securityContext: Record<string, unknown>;
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string; 'ephemeral-storage': string };
          };
        }[];
      };
    };
  };
}

const DEFAULT_REQUESTS = { cpu: '250m', memory: '512Mi' };
const DEFAULT_LIMITS = { cpu: '2', memory: '4Gi', 'ephemeral-storage': '10Gi' };

/** One agent-sandbox `Sandbox` object → one hardened pod (same name). */
export function buildSandboxManifest(params: SandboxManifestParams): SandboxManifest {
  const tenantLabel = { 'trueforge.dev/tenant': params.tenantName };
  return {
    apiVersion: SANDBOX_API_VERSION,
    kind: 'Sandbox',
    metadata: {
      name: params.name,
      namespace: params.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'trueforge', ...tenantLabel },
    },
    spec: {
      shutdownTime: params.shutdownTime.toISOString(),
      shutdownPolicy: 'Delete',
      podTemplate: {
        metadata: { labels: { 'app.kubernetes.io/name': 'trueforge-sandbox', ...tenantLabel } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...(params.runtimeClassName ? { runtimeClassName: params.runtimeClassName } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: SANDBOX_UID,
            runAsGroup: SANDBOX_UID,
            fsGroup: SANDBOX_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: SANDBOX_CONTAINER_NAME,
              image: params.image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'nats-ws', containerPort: DEFAULT_SANDBOX_NATS_WS_PORT }],
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              resources: {
                requests: { ...DEFAULT_REQUESTS, ...params.resources?.requests },
                limits: { ...DEFAULT_LIMITS, ...params.resources?.limits },
              },
            },
          ],
        },
      },
    },
  };
}

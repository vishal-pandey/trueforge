import {
  ApiException,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  PatchStrategy,
  setHeaderOptions,
  type V1Status,
} from '@kubernetes/client-node';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  ClusterExecTimeoutError,
  type ClusterExecParams,
  type ClusterExecResult,
  type KubernetesSandboxCluster,
  type SandboxPod,
} from './KubernetesSandboxCluster';
import { SANDBOX_CONTAINER_NAME, type SandboxManifest } from './sandboxManifest';

const GROUP = 'agents.x-k8s.io';
const VERSION = 'v1beta1';
const PLURAL = 'sandboxes';
const NOT_FOUND = 404;

interface SandboxObject {
  status?: {
    podIPs?: string[];
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiException && error.code === NOT_FOUND;
}

function readyPod(name: string, obj: SandboxObject): SandboxPod | undefined {
  const ready = obj.status?.conditions?.find(c => c.type === 'Ready');
  const podIp = obj.status?.podIPs?.[0];
  return ready?.status === 'True' && podIp ? { name, podIp } : undefined;
}

/** Exit code from the exec status channel: Success → 0, NonZeroExitCode → cause ExitCode. */
function exitCodeFromStatus(status: V1Status): number {
  if (status.status === 'Success') {
    return 0;
  }
  const cause = status.details?.causes?.find(c => c.reason === 'ExitCode');
  const code = cause?.message ? Number.parseInt(cause.message, 10) : Number.NaN;
  if (Number.isNaN(code)) {
    throw new Error(`Sandbox exec failed: ${status.message ?? status.reason ?? 'unknown error'}`);
  }
  return code;
}

export class ClientNodeSandboxCluster implements KubernetesSandboxCluster {
  private readonly namespace: string;
  private readonly custom: CustomObjectsApi;
  private readonly execApi: Exec;
  private readonly pollIntervalMs: number;

  constructor(params: { namespace: string; kubeConfig?: KubeConfig; pollIntervalMs?: number }) {
    const kc = params.kubeConfig ?? new KubeConfig();
    if (!params.kubeConfig) {
      kc.loadFromDefault();
    }
    this.namespace = params.namespace;
    this.custom = kc.makeApiClient(CustomObjectsApi);
    this.execApi = new Exec(kc);
    this.pollIntervalMs = params.pollIntervalMs ?? 1_000;
  }

  /** In-cluster service account when running in a pod, else ~/.kube/config / $KUBECONFIG. */
  static fromEnvironment(namespace: string): ClientNodeSandboxCluster {
    const kc = new KubeConfig();
    if (process.env['KUBERNETES_SERVICE_HOST']) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return new ClientNodeSandboxCluster({ namespace, kubeConfig: kc });
  }

  async create(manifest: SandboxManifest): Promise<void> {
    await this.custom.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
      body: manifest,
    });
  }

  private async get(name: string): Promise<SandboxObject | undefined> {
    try {
      return (await this.custom.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name,
      })) as SandboxObject;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async getReady(name: string): Promise<SandboxPod | undefined> {
    const obj = await this.get(name);
    return obj ? readyPod(name, obj) : undefined;
  }

  async waitForReady(name: string, timeoutMs: number): Promise<SandboxPod> {
    const deadline = Date.now() + timeoutMs;
    let last: SandboxObject | undefined;
    while (Date.now() < deadline) {
      last = await this.get(name);
      const pod = last ? readyPod(name, last) : undefined;
      if (pod) {
        return pod;
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
    }
    const ready = last?.status?.conditions?.find(c => c.type === 'Ready');
    throw new Error(
      `Sandbox ${name} not ready after ${String(timeoutMs)}ms` +
        (ready ? ` (${ready.reason ?? ''}: ${ready.message ?? ''})` : ''),
    );
  }

  async extendShutdown(name: string, shutdownTime: Date): Promise<void> {
    await this.custom.patchNamespacedCustomObject(
      {
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name,
        body: { spec: { shutdownTime: shutdownTime.toISOString() } },
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  }

  async delete(name: string): Promise<void> {
    try {
      await this.custom.deleteNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name,
      });
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }

  exec(params: ClusterExecParams): Promise<ClusterExecResult> {
    return new Promise<ClusterExecResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      // stderr is merged into stdout by the exec script; file ops send nothing useful there.
      const stderr = new PassThrough();
      stderr.resume();
      const stdin = params.stdin ? Readable.from([params.stdin]) : null;
      let settled = false;
      let socket: { close: () => void } | undefined;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        socket?.close();
        reject(new ClusterExecTimeoutError(params.timeoutMs));
      }, params.timeoutMs);

      this.execApi
        .exec(
          this.namespace,
          params.name,
          SANDBOX_CONTAINER_NAME,
          params.argv,
          stdout,
          stderr,
          stdin,
          false,
          status => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            try {
              resolve({ exitCode: exitCodeFromStatus(status), stdout: Buffer.concat(chunks) });
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        )
        .then(ws => {
          socket = ws;
          if (settled) {
            ws.close();
          }
        })
        .catch((error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}

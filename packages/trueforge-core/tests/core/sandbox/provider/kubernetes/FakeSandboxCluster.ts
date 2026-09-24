import {
  ClusterExecTimeoutError,
  type ClusterExecParams,
  type ClusterExecResult,
  type KubernetesSandboxCluster,
  type SandboxPod,
} from '../../../../../src/core/sandbox/provider/kubernetes/KubernetesSandboxCluster';
import type { SandboxManifest } from '../../../../../src/core/sandbox/provider/kubernetes/sandboxManifest';

type ExecHandler = (params: ClusterExecParams) => ClusterExecResult | Promise<ClusterExecResult>;

/** In-memory cluster: records calls, lets tests script exec results. */
export class FakeSandboxCluster implements KubernetesSandboxCluster {
  readonly created: SandboxManifest[] = [];
  readonly execCalls: ClusterExecParams[] = [];
  readonly shutdownUpdates: { name: string; shutdownTime: Date }[] = [];
  readonly deleted: string[] = [];
  private readonly running = new Map<string, SandboxPod>();
  private handler: ExecHandler = () => ({ exitCode: 0, stdout: Buffer.from('') });
  private nextIp = 10;

  onExec(handler: ExecHandler): void {
    this.handler = handler;
  }

  /** Simulates idle expiry / eviction. */
  expire(name: string): void {
    this.running.delete(name);
  }

  create(manifest: SandboxManifest): Promise<void> {
    this.created.push(manifest);
    this.running.set(manifest.metadata.name, {
      name: manifest.metadata.name,
      podIp: `10.0.0.${String(this.nextIp++)}`,
    });
    return Promise.resolve();
  }

  waitForReady(name: string): Promise<SandboxPod> {
    const pod = this.running.get(name);
    return pod ? Promise.resolve(pod) : Promise.reject(new Error(`not ready: ${name}`));
  }

  getReady(name: string): Promise<SandboxPod | undefined> {
    return Promise.resolve(this.running.get(name));
  }

  extendShutdown(name: string, shutdownTime: Date): Promise<void> {
    this.shutdownUpdates.push({ name, shutdownTime });
    return Promise.resolve();
  }

  delete(name: string): Promise<void> {
    this.deleted.push(name);
    this.running.delete(name);
    return Promise.resolve();
  }

  async exec(params: ClusterExecParams): Promise<ClusterExecResult> {
    this.execCalls.push(params);
    if (!this.running.has(params.name)) {
      throw new Error(`pods "${params.name}" not found`);
    }
    return this.handler(params);
  }
}

export { ClusterExecTimeoutError };

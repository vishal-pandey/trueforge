import type { SandboxManifest } from './sandboxManifest';

/** A running sandbox pod reachable on the cluster network. */
export interface SandboxPod {
  name: string;
  podIp: string;
}

export interface ClusterExecParams {
  /** Sandbox (== pod) name. */
  name: string;
  argv: string[];
  /** Bytes streamed to the process stdin, then stdin is closed. */
  stdin?: Buffer | undefined;
  /** Host-side deadline for the whole exec round-trip. */
  timeoutMs: number;
}

export interface ClusterExecResult {
  exitCode: number;
  /** Raw stdout bytes (binary-safe). */
  stdout: Buffer;
}

/** The exec websocket did not finish before the host-side deadline. */
export class ClusterExecTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Sandbox exec did not complete within ${String(timeoutMs)}ms`);
    this.name = 'ClusterExecTimeoutError';
  }
}

/**
 * Minimal cluster port the provider needs. The real implementation talks to the
 * agent-sandbox controller; tests use an in-memory fake.
 */
export interface KubernetesSandboxCluster {
  create(manifest: SandboxManifest): Promise<void>;
  /** Resolves once the Sandbox Ready condition is True; throws on timeout. */
  waitForReady(name: string, timeoutMs: number): Promise<SandboxPod>;
  /** Undefined when the Sandbox is missing, expired, or has no running pod. */
  getReady(name: string): Promise<SandboxPod | undefined>;
  extendShutdown(name: string, shutdownTime: Date): Promise<void>;
  delete(name: string): Promise<void>;
  exec(params: ClusterExecParams): Promise<ClusterExecResult>;
}

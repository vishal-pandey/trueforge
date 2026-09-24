import { randomUUID } from 'node:crypto';
import { join } from 'node:path/posix';
import type { Logger } from 'winston';
import { extractErrorLogFields } from '../../../util/errorLogFields';
import type { CodeModeTransport } from '../../codeMode/CodeModeTransport';
import { CodeModeNatsTransport } from '../../codeMode/nats/CodeModeNatsTransport';
import { DEFAULT_SANDBOX_NATS_WS_PORT } from '../../constants';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  validateSandboxOwnedByTenant,
} from '../../SandboxErrors';
import type { ExecResult, SandboxBuild, SandboxExecParams, SandboxProvider } from '../Provider';
import {
  STAT_EXIT_IS_DIR,
  STAT_EXIT_NOT_FOUND,
  buildCatArgv,
  buildExecArgv,
  buildStatArgv,
  buildUploadArgv,
  timeoutNote,
} from './execArgv';
import type { KubernetesSandboxCluster, SandboxPod } from './KubernetesSandboxCluster';
import { buildSandboxManifest, type SandboxResources } from './sandboxManifest';

/** Host-side slack over the in-pod `timeout` so the pod reports 124 before we give up. */
const HOST_DEADLINE_SLACK_MS = 15_000;
/** File ops (stat/cat/upload) deadline. */
const FILE_OP_TIMEOUT_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 300_000;
/** Push shutdownTime forward at most this often per sandbox. */
const SHUTDOWN_EXTEND_INTERVAL_MS = 60_000;

export interface KubernetesSandboxProviderOptions {
  cluster: KubernetesSandboxCluster;
  namespace: string;
  tenantName: string;
  sandboxImage: string;
  defaultExecTimeoutMs: number;
  idleTtlMinutes: number;
  fileMaxBytesForDownload: number;
  runtimeClassName?: string | undefined;
  resources?: SandboxResources | undefined;
  readyTimeoutMs?: number | undefined;
  natsBridgePort?: number | undefined;
  /** Injectable clock for tests. */
  now?: (() => Date) | undefined;
  logger: Logger;
}

export class KubernetesSandboxProvider implements SandboxProvider {
  readonly type = 'kubernetes';
  private readonly options: KubernetesSandboxProviderOptions;
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly natsBridgePort: number;
  /** k8s name → pod; process-wide so every turn reuses resolved pods. */
  private static readonly pods = new Map<string, SandboxPod>();
  /** k8s name → epoch ms of the last shutdownTime extension (or creation). */
  private static readonly lastExtended = new Map<string, number>();

  constructor(options: KubernetesSandboxProviderOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.natsBridgePort = options.natsBridgePort ?? DEFAULT_SANDBOX_NATS_WS_PORT;
    this.logger = options.logger.child({ module: 'KubernetesSandboxProvider' });
  }

  private shutdownTimeFromNow(): Date {
    return new Date(this.now().getTime() + this.options.idleTtlMinutes * 60_000);
  }

  private k8sName(sandboxId: string): string {
    validateSandboxOwnedByTenant({ sandboxId, tenantName: this.options.tenantName });
    return sandboxId.slice(sandboxId.indexOf('.') + 1);
  }

  async createSandbox(): Promise<{ sandboxId: string }> {
    const name = `tf-${randomUUID()}`;
    await this.options.cluster.create(
      buildSandboxManifest({
        name,
        namespace: this.options.namespace,
        tenantName: this.options.tenantName,
        image: this.options.sandboxImage,
        shutdownTime: this.shutdownTimeFromNow(),
        runtimeClassName: this.options.runtimeClassName,
        resources: this.options.resources,
      }),
    );
    const pod = await this.options.cluster.waitForReady(name, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    KubernetesSandboxProvider.pods.set(name, pod);
    KubernetesSandboxProvider.lastExtended.set(name, this.now().getTime());
    this.logger.debug(`Sandbox created: name=${name} ip=${pod.podIp}`);
    return { sandboxId: `${this.options.tenantName}.${name}` };
  }

  /** Resolves the running pod or throws SandboxNotAvailableError; keeps the idle TTL fresh. */
  private async resolvePod(sandboxId: string): Promise<SandboxPod> {
    const name = this.k8sName(sandboxId);
    let pod = KubernetesSandboxProvider.pods.get(name);
    if (!pod) {
      pod = await this.options.cluster.getReady(name);
      if (!pod) {
        throw new SandboxNotAvailableError(sandboxId);
      }
      KubernetesSandboxProvider.pods.set(name, pod);
    }
    await this.touch(name);
    return pod;
  }

  private async touch(name: string): Promise<void> {
    const nowMs = this.now().getTime();
    const last = KubernetesSandboxProvider.lastExtended.get(name) ?? 0;
    if (nowMs - last < SHUTDOWN_EXTEND_INTERVAL_MS) {
      return;
    }
    KubernetesSandboxProvider.lastExtended.set(name, nowMs);
    await this.options.cluster.extendShutdown(name, this.shutdownTimeFromNow());
  }

  /**
   * Runs an exec; if it fails because the pod vanished, re-resolves once so an expired
   * sandbox surfaces as SandboxNotAvailableError (TrueForge then recreates it).
   */
  private async clusterExec(sandboxId: string, argv: string[], timeoutMs: number, stdin?: Buffer) {
    const pod = await this.resolvePod(sandboxId);
    try {
      return await this.options.cluster.exec({ name: pod.name, argv, stdin, timeoutMs });
    } catch (error) {
      KubernetesSandboxProvider.pods.delete(pod.name);
      const stillThere = await this.options.cluster.getReady(pod.name);
      if (!stillThere) {
        throw new SandboxNotAvailableError(sandboxId);
      }
      throw error;
    }
  }

  async exec(params: SandboxExecParams): Promise<ExecResult> {
    // Tenant ownership is a hard error, never a soft `{ success: false }`.
    this.k8sName(params.sandboxId);
    const timeoutSeconds = params.timeoutSeconds ?? this.options.defaultExecTimeoutMs / 1000;
    const argv = buildExecArgv({ command: params.command, cwd: params.cwd, env: params.env, timeoutSeconds });
    try {
      const { exitCode, stdout } = await this.clusterExec(
        params.sandboxId,
        argv,
        Math.ceil(timeoutSeconds) * 1000 + HOST_DEADLINE_SLACK_MS,
      );
      return {
        success: true,
        response: { exitCode, result: stdout.toString('utf-8') + timeoutNote(exitCode, timeoutSeconds) },
      };
    } catch (error) {
      if (error instanceof SandboxNotAvailableError) {
        throw error;
      }
      this.logger.error('Sandbox execution error', extractErrorLogFields(error));
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async downloadFile(params: { sandboxId: string; path: string }): Promise<Buffer> {
    const stat = await this.clusterExec(params.sandboxId, buildStatArgv(params.path), FILE_OP_TIMEOUT_MS);
    if (stat.exitCode === STAT_EXIT_NOT_FOUND) {
      throw new SandboxFileNotFoundError(params.path);
    }
    if (stat.exitCode === STAT_EXIT_IS_DIR) {
      throw new SandboxPathIsDirectoryError(params.path);
    }
    if (stat.exitCode !== 0) {
      throw new Error(`stat failed (exit ${String(stat.exitCode)}): ${stat.stdout.toString('utf-8')}`);
    }
    const size = Number.parseInt(stat.stdout.toString('utf-8').trim(), 10);
    if (size > this.options.fileMaxBytesForDownload) {
      throw new SandboxFileTooLargeError(params.path, size, this.options.fileMaxBytesForDownload);
    }
    const cat = await this.clusterExec(params.sandboxId, buildCatArgv(params.path), FILE_OP_TIMEOUT_MS);
    if (cat.exitCode !== 0) {
      throw new SandboxFileNotFoundError(params.path);
    }
    return cat.stdout;
  }

  async uploadFile(params: { sandboxId: string; remotePath: string; content: Buffer }): Promise<void> {
    const result = await this.clusterExec(
      params.sandboxId,
      buildUploadArgv(params.remotePath),
      FILE_OP_TIMEOUT_MS,
      params.content,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Upload to ${params.remotePath} failed (exit ${String(result.exitCode)}): ${result.stdout.toString('utf-8')}`,
      );
    }
  }

  private buildStatus(): SandboxBuild {
    // Prebuilt image pulled by the kubelet — nothing to build.
    return { status: 'ready', reason: null, metadata: { image_uri: this.options.sandboxImage } };
  }

  buildImage(): Promise<SandboxBuild> {
    return Promise.resolve(this.buildStatus());
  }

  getImageBuildStatus(): Promise<SandboxBuild> {
    return Promise.resolve(this.buildStatus());
  }

  createCodeModeTransport(): CodeModeTransport {
    return new CodeModeNatsTransport({
      // Server pods reach sandbox pods directly on the cluster network (NetworkPolicy allows it).
      resolveHostUrl: async (sandboxId: string) => {
        const pod = await this.resolvePod(sandboxId);
        return `ws://${pod.podIp}:${String(this.natsBridgePort)}`;
      },
      sandboxClientNatsUrl: `ws://localhost:${String(this.natsBridgePort)}`,
      logger: this.logger,
      mcpClientInstall: {
        remotePath: join('/opt', 'tf', 'mcp-client', 'mcp_client.py'),
        pathBinSymlink: join('/opt', 'tf', 'bin', 'mcp-client'),
      },
    });
  }

  getAdditionalInstructions(): string | undefined {
    return undefined;
  }

  getToolResultDumpDir(): string {
    return join('/opt', 'tf', 'tool-results');
  }

  getGitCredentialsPath(): string {
    return join('/opt', 'tf', '.git-credentials');
  }

  getFileUploadsDir(): string {
    return join('/opt', 'tf', 'uploads');
  }

  getSkillsDir(): string {
    return join('/opt', 'tf', 'skills');
  }

  getSkillDownloaderPath(): string {
    return join('/opt', 'tf', 'skill_downloader.py');
  }
}

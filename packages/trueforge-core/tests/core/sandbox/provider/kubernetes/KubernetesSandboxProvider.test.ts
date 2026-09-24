import { createLogger } from 'winston';
import { KubernetesSandboxProvider } from '../../../../../src/core/sandbox/provider/kubernetes/KubernetesSandboxProvider';
import type { SandboxProvider } from '../../../../../src/core/sandbox/provider/Provider';
import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
  SandboxTenantMismatchError,
} from '../../../../../src/core/sandbox/SandboxErrors';
import { ClusterExecTimeoutError, FakeSandboxCluster } from './FakeSandboxCluster';

const IMAGE = 'ghcr.io/vishal-pandey/trueforge-sandbox:v1.0.0';

function setup(overrides: Partial<ConstructorParameters<typeof KubernetesSandboxProvider>[0]> = {}) {
  const cluster = new FakeSandboxCluster();
  let now = new Date('2026-09-24T10:00:00.000Z');
  const provider = new KubernetesSandboxProvider({
    cluster,
    namespace: 'trueforge-sandboxes',
    tenantName: 'default',
    sandboxImage: IMAGE,
    defaultExecTimeoutMs: 60_000,
    idleTtlMinutes: 60,
    fileMaxBytesForDownload: 1024,
    now: () => now,
    logger: createLogger({ silent: true }),
    ...overrides,
  });
  return { cluster, provider, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('KubernetesSandboxProvider', () => {
  it('createSandbox creates a Sandbox named tf-<uuid> and returns a tenant-scoped id', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    expect(sandboxId).toMatch(/^default\.tf-[0-9a-f-]{36}$/);
    expect(cluster.created).toHaveLength(1);
    expect(cluster.created[0]?.metadata.name).toBe(sandboxId.slice('default.'.length));
    expect(cluster.created[0]?.spec.shutdownTime).toBe('2026-09-24T11:00:00.000Z');
    expect(cluster.created[0]?.spec.podTemplate.spec.containers[0]?.image).toBe(IMAGE);
  });

  it('exec returns merged output and exit code, with the default timeout', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.onExec(() => ({ exitCode: 2, stdout: Buffer.from('out\nerr\n') }));
    const result = await provider.exec({ sandboxId, command: 'false' });
    expect(result).toEqual({ success: true, response: { exitCode: 2, result: 'out\nerr\n' } });
    const call = cluster.execCalls[0];
    expect(call?.argv.slice(0, 3)).toEqual(['timeout', '--kill-after=5s', '60s']);
    expect(call?.timeoutMs).toBe(75_000);
  });

  it('exec honours a per-call timeout override', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    await provider.exec({ sandboxId, command: 'sleep 1', timeoutSeconds: 180 });
    expect(cluster.execCalls[0]?.argv[2]).toBe('180s');
    expect(cluster.execCalls[0]?.timeoutMs).toBe(195_000);
  });

  it('timeout exit code 124 adds note', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.onExec(() => ({ exitCode: 124, stdout: Buffer.from('partial') }));
    const result = await provider.exec({ sandboxId, command: 'sleep 999', timeoutSeconds: 2 });
    expect(result).toEqual({
      success: true,
      response: { exitCode: 124, result: 'partial\n[command timed out after 2s]' },
    });
  });

  it('host deadline on exec returns an infra failure', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.onExec(() => {
      throw new ClusterExecTimeoutError(75_000);
    });
    const result = await provider.exec({ sandboxId, command: 'hang' });
    expect(result).toEqual({ success: false, error: 'Sandbox exec did not complete within 75000ms' });
  });

  it('exec on missing sandbox throws SandboxNotAvailableError', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.expire(sandboxId.slice('default.'.length));
    await expect(provider.exec({ sandboxId, command: 'true' })).rejects.toBeInstanceOf(SandboxNotAvailableError);
  });

  it('rejects sandbox ids from another tenant', async () => {
    const { provider } = setup();
    await expect(provider.exec({ sandboxId: 'other.tf-x', command: 'true' })).rejects.toBeInstanceOf(
      SandboxTenantMismatchError,
    );
  });

  it('extends shutdownTime on activity, at most once per minute', async () => {
    const { cluster, provider, advance } = setup();
    const { sandboxId } = await provider.createSandbox();
    await provider.exec({ sandboxId, command: 'true' });
    await provider.exec({ sandboxId, command: 'true' });
    expect(cluster.shutdownUpdates).toHaveLength(0); // created with a fresh TTL just now
    advance(61_000);
    await provider.exec({ sandboxId, command: 'true' });
    expect(cluster.shutdownUpdates).toEqual([
      { name: sandboxId.slice('default.'.length), shutdownTime: new Date('2026-09-24T11:01:01.000Z') },
    ]);
  });

  it('upload streams bytes to stdin; download round-trips binary', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    const bytes = Buffer.from([0, 255, 10, 13, 128, 1]);
    const files = new Map<string, Buffer>();
    cluster.onExec(({ argv, stdin }) => {
      if (argv[2] === 'mkdir -p "$(dirname "$1")" && cat > "$1"') {
        files.set(argv[4] ?? '', stdin ?? Buffer.alloc(0));
        return { exitCode: 0, stdout: Buffer.alloc(0) };
      }
      if (argv[0] === '/bin/sh') {
        const f = files.get(argv[4] ?? '');
        return f
          ? { exitCode: 0, stdout: Buffer.from(`${String(f.length)}\n`) }
          : { exitCode: 3, stdout: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: files.get(argv[2] ?? '') ?? Buffer.alloc(0) };
    });
    await provider.uploadFile({ sandboxId, remotePath: '/opt/tf/uploads/b.bin', content: bytes });
    await expect(provider.downloadFile({ sandboxId, path: '/opt/tf/uploads/b.bin' })).resolves.toEqual(bytes);
  });

  it('download maps missing/dir/too-large to domain errors', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.onExec(() => ({ exitCode: 3, stdout: Buffer.alloc(0) }));
    await expect(provider.downloadFile({ sandboxId, path: '/x' })).rejects.toBeInstanceOf(SandboxFileNotFoundError);
    cluster.onExec(() => ({ exitCode: 4, stdout: Buffer.alloc(0) }));
    await expect(provider.downloadFile({ sandboxId, path: '/x' })).rejects.toBeInstanceOf(SandboxPathIsDirectoryError);
    cluster.onExec(() => ({ exitCode: 0, stdout: Buffer.from('4096\n') }));
    await expect(provider.downloadFile({ sandboxId, path: '/x' })).rejects.toBeInstanceOf(SandboxFileTooLargeError);
    expect(cluster.execCalls.filter(c => c.argv[0] === 'cat')).toHaveLength(0);
  });

  it('download on missing sandbox throws SandboxNotAvailableError', async () => {
    const { cluster, provider } = setup();
    const { sandboxId } = await provider.createSandbox();
    cluster.expire(sandboxId.slice('default.'.length));
    await expect(provider.downloadFile({ sandboxId, path: '/x' })).rejects.toBeInstanceOf(SandboxNotAvailableError);
  });

  it('buildImage/getImageBuildStatus report ready with the image uri', async () => {
    const { provider } = setup();
    const expected = { status: 'ready', reason: null, metadata: { image_uri: IMAGE } };
    await expect(provider.buildImage()).resolves.toEqual(expected);
    await expect(provider.getImageBuildStatus()).resolves.toEqual(expected);
  });

  it('uses the Daytona-compatible /opt/tf layout', () => {
    const { provider: concrete } = setup();
    const provider: SandboxProvider = concrete;
    expect(provider.getToolResultDumpDir('default.tf-a')).toBe('/opt/tf/tool-results');
    expect(provider.getGitCredentialsPath('default.tf-a')).toBe('/opt/tf/.git-credentials');
    expect(provider.getFileUploadsDir('default.tf-a')).toBe('/opt/tf/uploads');
    expect(provider.getSkillsDir('default.tf-a')).toBe('/opt/tf/skills');
    expect(provider.getSkillDownloaderPath('default.tf-a')).toBe('/opt/tf/skill_downloader.py');
    expect(provider.getAdditionalInstructions()).toBeUndefined();
  });

  it('code mode transport installs the MCP client under /opt/tf', () => {
    const { provider } = setup();
    const install = provider.createCodeModeTransport().getClientInstall({ sandboxId: 'default.tf-a' });
    expect(install.remotePath).toBe('/opt/tf/mcp-client/mcp_client.py');
  });
});

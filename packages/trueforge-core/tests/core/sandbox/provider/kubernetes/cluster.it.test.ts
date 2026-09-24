/**
 * @jest-environment ./tests/core/sandbox/provider/kubernetes/nodeRealmEnvironment.cjs
 */
import { randomBytes } from 'node:crypto';
import { createLogger } from 'winston';
import { ClientNodeSandboxCluster } from '../../../../../src/core/sandbox/provider/kubernetes/ClientNodeSandboxCluster';
import { ClusterExecTimeoutError } from '../../../../../src/core/sandbox/provider/kubernetes/KubernetesSandboxCluster';
import { KubernetesSandboxProvider } from '../../../../../src/core/sandbox/provider/kubernetes/KubernetesSandboxProvider';
import { SandboxNotAvailableError } from '../../../../../src/core/sandbox/SandboxErrors';

const RUN = process.env['KUBE_SANDBOX_IT'] === '1';
const NAMESPACE = process.env['KUBE_SANDBOX_IT_NAMESPACE'] ?? 'trueforge-sandbox-it';
// Public image with /bin/sh, coreutils timeout, stat, cat — the real sandbox image comes in Task 5.
const IMAGE = process.env['KUBE_SANDBOX_IT_IMAGE'] ?? 'python:3.13-slim-bookworm';

(RUN ? describe : describe.skip)('ClientNodeSandboxCluster (live cluster)', () => {
  const cluster = ClientNodeSandboxCluster.fromEnvironment(NAMESPACE);
  const provider = new KubernetesSandboxProvider({
    cluster,
    namespace: NAMESPACE,
    tenantName: 'it',
    sandboxImage: IMAGE,
    defaultExecTimeoutMs: 30_000,
    idleTtlMinutes: 10,
    fileMaxBytesForDownload: 10 * 1024 * 1024,
    // The python image has no /home/trueforge; the manifest forces uid 1000 — every exec passes cwd '/tmp'.
    logger: createLogger({ silent: true }),
  });
  let sandboxId = '';

  beforeAll(async () => {
    ({ sandboxId } = await provider.createSandbox());
  }, 300_000);

  afterAll(async () => {
    if (sandboxId) {
      await cluster.delete(sandboxId.slice(sandboxId.indexOf('.') + 1));
    }
  }, 60_000);

  it('exec merges stderr, reports exit code, and runs as uid 1000', async () => {
    const r = await provider.exec({ sandboxId, command: 'echo out; echo err >&2; id -u; exit 3', cwd: '/tmp' });
    expect(r).toEqual({ success: true, response: { exitCode: 3, result: 'out\nerr\n1000\n' } });
  }, 60_000);

  it('state persists across execs', async () => {
    await provider.exec({ sandboxId, command: 'echo persist > /tmp/p.txt', cwd: '/tmp' });
    const r = await provider.exec({ sandboxId, command: 'cat /tmp/p.txt', cwd: '/tmp' });
    expect(r.success && r.response.result).toBe('persist\n');
  }, 60_000);

  it('5 MB binary upload/download round-trips byte-exact', async () => {
    const bytes = randomBytes(5 * 1024 * 1024);
    await provider.uploadFile({ sandboxId, remotePath: '/tmp/up/rand.bin', content: bytes });
    const back = await provider.downloadFile({ sandboxId, path: '/tmp/up/rand.bin' });
    expect(back.equals(bytes)).toBe(true);
  }, 120_000);

  it('in-pod timeout yields 124', async () => {
    const r = await provider.exec({ sandboxId, command: 'sleep 30', cwd: '/tmp', timeoutSeconds: 2 });
    expect(r.success && r.response.exitCode).toBe(124);
  }, 60_000);

  it('host deadline bounds a hung exec', async () => {
    const name = sandboxId.slice(sandboxId.indexOf('.') + 1);
    await expect(cluster.exec({ name, argv: ['sleep', '30'], timeoutMs: 2_000 })).rejects.toBeInstanceOf(
      ClusterExecTimeoutError,
    );
  }, 60_000);

  it('deleted sandbox surfaces as SandboxNotAvailableError', async () => {
    const { sandboxId: doomed } = await provider.createSandbox();
    await cluster.delete(doomed.slice(doomed.indexOf('.') + 1));
    // Wait for the pod to be gone.
    await new Promise(resolve => setTimeout(resolve, 15_000));
    const fresh = new KubernetesSandboxProvider({
      cluster,
      namespace: NAMESPACE,
      tenantName: 'it',
      sandboxImage: IMAGE,
      defaultExecTimeoutMs: 30_000,
      idleTtlMinutes: 10,
      fileMaxBytesForDownload: 1024,
      logger: createLogger({ silent: true }),
    });
    // Static pod cache would still hold it; the exec failure path must re-check and throw.
    await expect(fresh.exec({ sandboxId: doomed, command: 'true', cwd: '/tmp' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
  }, 360_000);
});

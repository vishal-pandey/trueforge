import { readKubernetesSandboxConfig } from '../../../../src/sandbox/kubernetes/kubernetesSandboxConfig';

describe('readKubernetesSandboxConfig', () => {
  it('is undefined unless enabled', () => {
    expect(readKubernetesSandboxConfig({})).toBeUndefined();
    expect(readKubernetesSandboxConfig({ KUBERNETES_SANDBOX_ENABLED: 'false' })).toBeUndefined();
  });

  it('applies defaults', () => {
    expect(
      readKubernetesSandboxConfig({ KUBERNETES_SANDBOX_ENABLED: 'true', KUBERNETES_SANDBOX_IMAGE: 'ghcr.io/x/sb:v1' }),
    ).toEqual({
      namespace: 'trueforge-sandboxes',
      image: 'ghcr.io/x/sb:v1',
      idleTtlMinutes: 60,
      execTimeoutMs: 60_000,
      runtimeClassName: undefined,
    });
  });

  it('parses overrides', () => {
    expect(
      readKubernetesSandboxConfig({
        KUBERNETES_SANDBOX_ENABLED: 'true',
        KUBERNETES_SANDBOX_IMAGE: 'img',
        KUBERNETES_SANDBOX_NAMESPACE: 'sb',
        KUBERNETES_SANDBOX_IDLE_TTL_MINUTES: '15',
        KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS: '120000',
        KUBERNETES_SANDBOX_RUNTIME_CLASS: 'gvisor',
      }),
    ).toEqual({
      namespace: 'sb',
      image: 'img',
      idleTtlMinutes: 15,
      execTimeoutMs: 120_000,
      runtimeClassName: 'gvisor',
    });
  });

  it('fails fast on a missing image or bad numbers', () => {
    expect(() => readKubernetesSandboxConfig({ KUBERNETES_SANDBOX_ENABLED: 'true' })).toThrow(
      'KUBERNETES_SANDBOX_IMAGE',
    );
    expect(() =>
      readKubernetesSandboxConfig({
        KUBERNETES_SANDBOX_ENABLED: 'true',
        KUBERNETES_SANDBOX_IMAGE: 'i',
        KUBERNETES_SANDBOX_IDLE_TTL_MINUTES: '0',
      }),
    ).toThrow('KUBERNETES_SANDBOX_IDLE_TTL_MINUTES');
  });
});

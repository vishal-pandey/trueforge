import { buildSandboxManifest } from '../../../../../src/core/sandbox/provider/kubernetes/sandboxManifest';

const base = {
  name: 'tf-abc',
  namespace: 'trueforge-sandboxes',
  tenantName: 'default',
  image: 'ghcr.io/vishal-pandey/trueforge-sandbox:v1.0.0',
  shutdownTime: new Date('2026-09-24T12:00:00.000Z'),
};

describe('buildSandboxManifest', () => {
  it('builds a Sandbox CR with lifecycle and hardened pod', () => {
    const m = buildSandboxManifest(base);
    expect(m.apiVersion).toBe('agents.x-k8s.io/v1beta1');
    expect(m.kind).toBe('Sandbox');
    expect(m.metadata).toEqual({
      name: 'tf-abc',
      namespace: 'trueforge-sandboxes',
      labels: { 'app.kubernetes.io/managed-by': 'trueforge', 'trueforge.dev/tenant': 'default' },
    });
    expect(m.spec.shutdownTime).toBe('2026-09-24T12:00:00.000Z');
    expect(m.spec.shutdownPolicy).toBe('Delete');
    const pod = m.spec.podTemplate;
    expect(pod.metadata.labels).toEqual({
      'app.kubernetes.io/name': 'trueforge-sandbox',
      'trueforge.dev/tenant': 'default',
    });
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.securityContext).toEqual({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: 'RuntimeDefault' },
    });
    const c = pod.spec.containers[0];
    expect(c?.name).toBe('sandbox');
    expect(c?.image).toBe(base.image);
    expect(c?.securityContext).toEqual({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(c?.ports).toEqual([{ name: 'nats-ws', containerPort: 4444 }]);
    expect(c?.resources).toEqual({
      requests: { cpu: '250m', memory: '512Mi' },
      limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '10Gi' },
    });
    expect(pod.spec.runtimeClassName).toBeUndefined();
  });

  it('sets runtimeClassName when configured (gVisor switch)', () => {
    const m = buildSandboxManifest({ ...base, runtimeClassName: 'gvisor' });
    expect(m.spec.podTemplate.spec.runtimeClassName).toBe('gvisor');
  });

  it('applies resource overrides', () => {
    const m = buildSandboxManifest({
      ...base,
      resources: { limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '2Gi' } },
    });
    expect(m.spec.podTemplate.spec.containers[0]?.resources.limits).toEqual({
      cpu: '1',
      memory: '1Gi',
      'ephemeral-storage': '2Gi',
    });
    expect(m.spec.podTemplate.spec.containers[0]?.resources.requests).toEqual({ cpu: '250m', memory: '512Mi' });
  });
});

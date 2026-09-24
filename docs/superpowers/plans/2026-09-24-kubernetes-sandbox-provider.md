# Kubernetes Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run TrueForge agent sandboxes as pods on the homelab Kubernetes cluster via a new `kubernetes` sandbox provider in the `vishal-pandey/trueforge` fork.

**Architecture:** A `KubernetesSandboxProvider` in trueforge-core implements `SandboxProvider` on top of a small `KubernetesSandboxCluster` port (create/get/extend/delete a `Sandbox` CR, exec in its pod). The real port uses `@kubernetes/client-node` against the kubernetes-sigs agent-sandbox v1.0.3 controller; unit tests use an in-memory fake. The server enables the provider from `KUBERNETES_SANDBOX_*` env through an env-synthesized store (same pattern as `TrueFoundrySandboxProviderStore`), and the UI shows a read-only managed row.

**Tech Stack:** TypeScript (Node 22, pnpm 11 workspace), Jest + @swc/jest, zod 4, Hono, `@kubernetes/client-node` 2.0.0, agent-sandbox v1.0.3 (`agents.x-k8s.io/v1beta1`), GitHub Actions → GHCR, ArgoCD/kustomize (`vishal-pandey/argocd-apps`).

**Spec:** `docs/superpowers/specs/2026-09-24-kubernetes-sandbox-design.md`

## Global Constraints

- Fork base: tag `@truefoundry/trueforge@0.2.1`; all work on fork branch `main`.
- CRD: group `agents.x-k8s.io`, version `v1beta1`, plural `sandboxes`, kind `Sandbox`; pod name == Sandbox name.
- Sandbox namespace: `trueforge-sandboxes`. Container name: `sandbox`.
- Sandbox id format: `<tenant_id>.<k8sName>`, `k8sName = "tf-" + randomUUID()`.
- Sandbox pod user: uid/gid `1000`; `HOME=/home/trueforge`; working dir `/home/trueforge`.
- Layout: `/opt/tf/{uploads,skills,tool-results}`, `/opt/tf/skill_downloader.py`, `/opt/tf/.git-credentials`, MCP client `/opt/tf/mcp-client/mcp_client.py`, symlink `/opt/tf/bin/mcp-client` (on image `PATH`).
- Code Mode NATS WebSocket port: `4444` (`DEFAULT_SANDBOX_NATS_WS_PORT`).
- Defaults: exec timeout `60000` ms; idle TTL `60` min; readiness wait `300000` ms; limits cpu `2` / memory `4Gi` / ephemeral-storage `10Gi`; requests cpu `250m` / memory `512Mi`.
- Env var names (server): `KUBERNETES_SANDBOX_ENABLED`, `KUBERNETES_SANDBOX_NAMESPACE`, `KUBERNETES_SANDBOX_IMAGE`, `KUBERNETES_SANDBOX_IDLE_TTL_MINUTES`, `KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS`, `KUBERNETES_SANDBOX_RUNTIME_CLASS`.
- UI display name: `Kubernetes (homelab)`.
- Never run `docker build`/`docker push` locally; images come from GitHub Actions.
- Cluster is Kubernetes v1.30.14; pod CIDR `192.168.0.0/16`, service CIDR `10.96.0.0/12`, LAN `192.168.1.0/24`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Env values with quotes, newlines, `$`, or non-identifier keys** — exec must pass them literally, never let them break or inject into the shell script; invalid keys rejected. (Task 2 test: `buildExecArgv escapes hostile env values` / `rejects invalid env keys`.)
2. **Sandbox expired or deleted between calls** (idle TTL hit, pod evicted) — every provider method must throw `SandboxNotAvailableError` so TrueForge recreates it, not a generic 500. (Task 2 tests: `exec on missing sandbox throws SandboxNotAvailableError`, `download on missing sandbox…`.)
3. **Binary and large files** — upload/download must be byte-exact (no UTF-8 mangling) and over-limit downloads must raise `SandboxFileTooLargeError` before transferring. (Task 2 unit tests + Task 3 integration test with 5 MB random bytes.)
4. **Command runs past its timeout** — returns exit code 124 with a timeout note, and a hung exec websocket is bounded by a host-side deadline returning `{ success: false }`. (Task 2 test `timeout exit code 124 adds note`; Task 3 test `host deadline bounds a hung exec`.)
5. **Sandbox pod reaching the cluster or LAN** — NetworkPolicy must block pg-ha, the Kubernetes API, and 192.168.1.0/24 while allowing internet + DNS. (Task 7 verification steps with explicit expected failures/successes.)

---

## File Structure

**trueforge-core** (`packages/trueforge-core/`)
- Create `src/core/sandbox/provider/kubernetes/KubernetesSandboxCluster.ts` — port interface + `SandboxPod` type.
- Create `src/core/sandbox/provider/kubernetes/execArgv.ts` — pure builders: exec argv, stat/cat/upload argv, timeout note.
- Create `src/core/sandbox/provider/kubernetes/sandboxManifest.ts` — pure builder for the `Sandbox` CR body.
- Create `src/core/sandbox/provider/kubernetes/KubernetesSandboxProvider.ts` — the provider.
- Create `src/core/sandbox/provider/kubernetes/ClientNodeSandboxCluster.ts` — real port on `@kubernetes/client-node`.
- Modify `src/core/index.ts` — export the provider, cluster, types.
- Modify `package.json` — add `@kubernetes/client-node@2.0.0`.
- Tests: `tests/core/sandbox/provider/kubernetes/{execArgv,sandboxManifest,KubernetesSandboxProvider}.test.ts`, `FakeSandboxCluster.ts`, and `tests/core/sandbox/provider/kubernetes/cluster.it.test.ts` (gated by `KUBE_SANDBOX_IT=1`).

**trueforge server** (`packages/trueforge/`)
- Create `src/sandbox/kubernetes/kubernetesSandboxConfig.ts` — env parsing (zod).
- Create `src/sandbox/kubernetes/KubernetesSandboxProviderStore.ts` — env-synthesized store.
- Modify `src/schemas/sandboxProvider.ts` — `KubernetesSandboxProviderSchema` in the stored union.
- Modify `src/sandbox/providerUtils.ts` — `kubernetes` case in `toSandboxProviderFromRecord` and `checkSnapshotStatus`.
- Modify `src/main.ts` — store resolver prefers the kubernetes store when enabled.
- Modify `src/apis/sandboxProviders.ts` — `GET /managed` endpoint.
- Tests under `tests/unit/sandbox/kubernetes/` and `tests/unit/apis/sandboxProvidersManaged.test.ts`.

**trueforge-ui** (`packages/trueforge-ui/`)
- Modify `src/plugins/trueforge-agent-server-adapter/catalogs/sandboxProviderCatalog.ts` — managed-provider fetch + mapping.
- Modify `src/plugins/trueforge-agent-server-adapter/index.ts` — pass client options.
- Modify `src/containers/SettingsBuilder/SandboxSettings.tsx` — hide Update/Retry for managed rows.
- Tests: extend `test/plugins/trueforge-agent-server-adapter/catalogs/sandboxProviderCatalog.test.ts`, `test/containers/SettingsBuilder/SandboxSettings.test.tsx`.

**Images / CI** (repo root)
- Create `deploy/homelab/sandbox.Dockerfile`, `deploy/homelab/nats.supervisor.conf`, `deploy/homelab/supervisord.conf`.
- Create `.github/workflows/homelab-images.yml` (via the `homelab-host:github-action-ci-setup` skill for the server image + a sandbox-image job).

**Homelab** (`/home/vishal/argocd-apps` on the server)
- Create `components/agent-sandbox/` (release manifest v1.0.3), `apps/templates/business/agent-sandbox.yaml`.
- Create `components/trueforge-sandboxes/` (namespace, NetworkPolicy, ResourceQuota, LimitRange, Role/RoleBinding), app yaml.
- Modify `components/trueforge/` (ServiceAccount, image, env).

---

### Task 1: Fork baseline and dependency

**Files:**
- Modify: `packages/trueforge-core/package.json`, `pnpm-lock.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces: fork `main` at tag `@truefoundry/trueforge@0.2.1` + docs; `@kubernetes/client-node` importable from trueforge-core.

- [ ] **Step 1: Reset fork main to the release tag, keeping the docs**

```bash
cd ~/Business/trueforge
git stash -u   # holds docs/superpowers/*
git fetch upstream --tags
git checkout -B main '@truefoundry/trueforge@0.2.1'
git stash pop
git add docs/superpowers
git commit -m "docs: kubernetes sandbox provider spec and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Install and prove the baseline tests pass**

Run: `pnpm install --frozen-lockfile && pnpm --filter @truefoundry/trueforge-core test -- tests/core/sandbox`
Expected: PASS (all existing sandbox tests green). If anything fails here, stop — the baseline is broken, not our code.

- [ ] **Step 3: Add the Kubernetes client**

Run: `pnpm --filter @truefoundry/trueforge-core add @kubernetes/client-node@2.0.0`
Expected: `package.json` dependencies gain `"@kubernetes/client-node": "2.0.0"`; lockfile updated.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @truefoundry/trueforge-core typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit and force-push the fork main**

```bash
git add packages/trueforge-core/package.json pnpm-lock.yaml
git commit -m "chore(core): add @kubernetes/client-node for kubernetes sandbox provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push --force origin main
```

---

### Task 2: Kubernetes sandbox provider (core, fake-cluster tested)

**Files:**
- Create: `packages/trueforge-core/src/core/sandbox/provider/kubernetes/KubernetesSandboxCluster.ts`
- Create: `packages/trueforge-core/src/core/sandbox/provider/kubernetes/execArgv.ts`
- Create: `packages/trueforge-core/src/core/sandbox/provider/kubernetes/sandboxManifest.ts`
- Create: `packages/trueforge-core/src/core/sandbox/provider/kubernetes/KubernetesSandboxProvider.ts`
- Modify: `packages/trueforge-core/src/core/index.ts` (after line 183, the `TFYSandboxProvider` export)
- Test: `packages/trueforge-core/tests/core/sandbox/provider/kubernetes/FakeSandboxCluster.ts`
- Test: `packages/trueforge-core/tests/core/sandbox/provider/kubernetes/execArgv.test.ts`
- Test: `packages/trueforge-core/tests/core/sandbox/provider/kubernetes/sandboxManifest.test.ts`
- Test: `packages/trueforge-core/tests/core/sandbox/provider/kubernetes/KubernetesSandboxProvider.test.ts`

**Interfaces:**
- Consumes: `SandboxProvider`, `ExecResult`, `SandboxBuild`, `SandboxExecParams`, `shellEscape` (`../Provider`); `SandboxNotAvailableError`, `SandboxFileNotFoundError`, `SandboxFileTooLargeError`, `SandboxPathIsDirectoryError`, `validateSandboxOwnedByTenant` (`../../SandboxErrors`); `CodeModeNatsTransport` (`../../codeMode/nats/CodeModeNatsTransport`); `DEFAULT_SANDBOX_NATS_WS_PORT` (`../../constants`).
- Produces:
  - `interface SandboxPod { name: string; podIp: string }`
  - `interface KubernetesSandboxCluster { create(manifest: SandboxManifest): Promise<void>; waitForReady(name: string, timeoutMs: number): Promise<SandboxPod>; getReady(name: string): Promise<SandboxPod | undefined>; extendShutdown(name: string, shutdownTime: Date): Promise<void>; delete(name: string): Promise<void>; exec(params: ClusterExecParams): Promise<ClusterExecResult> }`
  - `interface ClusterExecParams { name: string; argv: string[]; stdin?: Buffer | undefined; timeoutMs: number }`
  - `interface ClusterExecResult { exitCode: number; stdout: Buffer }`
  - `class ClusterExecTimeoutError extends Error`
  - `buildSandboxManifest(params: SandboxManifestParams): SandboxManifest`
  - `buildExecArgv(params: { command: string; cwd?: string; env?: Record<string, string>; timeoutSeconds: number }): string[]`
  - `class KubernetesSandboxProvider implements SandboxProvider` with `readonly type = 'kubernetes'` and constructor `KubernetesSandboxProviderOptions`.

- [ ] **Step 1: Write the port interface (no test — types only)**

`KubernetesSandboxCluster.ts`:

```ts
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
```

- [ ] **Step 2: Write failing tests for the manifest builder**

`sandboxManifest.test.ts`:

```ts
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
    expect(pod.metadata.labels).toEqual({ 'app.kubernetes.io/name': 'trueforge-sandbox', 'trueforge.dev/tenant': 'default' });
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
    const m = buildSandboxManifest({ ...base, resources: { limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '2Gi' } } });
    expect(m.spec.podTemplate.spec.containers[0]?.resources.limits).toEqual({ cpu: '1', memory: '1Gi', 'ephemeral-storage': '2Gi' });
    expect(m.spec.podTemplate.spec.containers[0]?.resources.requests).toEqual({ cpu: '250m', memory: '512Mi' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes/sandboxManifest.test.ts`
Expected: FAIL — `Cannot find module '.../sandboxManifest'`.

- [ ] **Step 4: Implement the manifest builder**

`sandboxManifest.ts`:

```ts
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
        containers: Array<{
          name: string;
          image: string;
          imagePullPolicy: 'IfNotPresent';
          ports: Array<{ name: string; containerPort: number }>;
          securityContext: Record<string, unknown>;
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string; 'ephemeral-storage': string };
          };
        }>;
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
```

- [ ] **Step 5: Run manifest tests**

Run: same command as Step 3. Expected: PASS (3 tests).

- [ ] **Step 6: Write failing tests for argv builders**

`execArgv.test.ts`:

```ts
import {
  EXEC_TIMEOUT_EXIT_CODE,
  buildExecArgv,
  buildStatArgv,
  buildUploadArgv,
  timeoutNote,
} from '../../../../../src/core/sandbox/provider/kubernetes/execArgv';

describe('buildExecArgv', () => {
  it('wraps the command in timeout + sh with stderr merged and cwd', () => {
    const argv = buildExecArgv({ command: 'echo hi', cwd: '/opt/tf', timeoutSeconds: 30 });
    expect(argv.slice(0, 4)).toEqual(['timeout', '--kill-after=5s', '30s', '/bin/sh']);
    expect(argv[4]).toBe('-c');
    expect(argv[5]).toBe("exec 2>&1\ncd '/opt/tf' || exit 1\necho hi");
  });

  it('defaults cwd to the sandbox home', () => {
    expect(buildExecArgv({ command: 'pwd', timeoutSeconds: 5 })[5]).toBe("exec 2>&1\ncd '/home/trueforge' || exit 1\npwd");
  });

  it('escapes hostile env values literally', () => {
    const script = buildExecArgv({
      command: 'printenv A',
      env: { A: `it's "$HOME"\n; rm -rf /` },
      timeoutSeconds: 5,
    })[5];
    expect(script).toBe(`exec 2>&1\nexport A='it'\\''s "$HOME"\n; rm -rf /'\ncd '/home/trueforge' || exit 1\nprintenv A`);
  });

  it('rejects invalid env keys', () => {
    expect(() => buildExecArgv({ command: 'true', env: { 'A;B': 'x' }, timeoutSeconds: 5 })).toThrow('Invalid environment variable name: A;B');
  });

  it('rounds timeout up to whole seconds, minimum 1', () => {
    expect(buildExecArgv({ command: 'true', timeoutSeconds: 0.2 })[2]).toBe('1s');
    expect(buildExecArgv({ command: 'true', timeoutSeconds: 1.5 })[2]).toBe('2s');
  });
});

describe('file argv', () => {
  it('stat reports size and maps missing/dir to exit codes 3/4 without interpolating the path', () => {
    const argv = buildStatArgv("/tmp/a b'c");
    expect(argv[0]).toBe('/bin/sh');
    expect(argv[argv.length - 1]).toBe("/tmp/a b'c");
    expect(argv[2]).toContain('exit 3');
    expect(argv[2]).toContain('exit 4');
    expect(argv[2]).not.toContain("a b'c");
  });

  it('upload creates the parent dir and writes stdin to the path', () => {
    const argv = buildUploadArgv('/opt/tf/uploads/x.bin');
    expect(argv).toEqual(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', '/opt/tf/uploads/x.bin']);
  });
});

describe('timeoutNote', () => {
  it('is appended only for the timeout exit code', () => {
    expect(EXEC_TIMEOUT_EXIT_CODE).toBe(124);
    expect(timeoutNote(124, 30)).toBe('\n[command timed out after 30s]');
    expect(timeoutNote(0, 30)).toBe('');
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes/execArgv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement argv builders**

`execArgv.ts`:

```ts
import { shellEscape } from '../Provider';

export const SANDBOX_HOME = '/home/trueforge';
/** GNU `timeout` exit status when the command ran past its deadline. */
export const EXEC_TIMEOUT_EXIT_CODE = 124;
/** `buildStatArgv` exit codes. */
export const STAT_EXIT_NOT_FOUND = 3;
export const STAT_EXIT_IS_DIR = 4;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Exec argv for one command: in-pod `timeout`, stderr merged into stdout, env exported
 * via shell-escaped literals, cwd defaulting to the sandbox home.
 */
export function buildExecArgv(params: {
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutSeconds: number;
}): string[] {
  const exports = Object.entries(params.env ?? {}).map(([key, value]) => {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    return `export ${key}=${shellEscape(value)}`;
  });
  const script = ['exec 2>&1', ...exports, `cd ${shellEscape(params.cwd ?? SANDBOX_HOME)} || exit 1`, params.command].join(
    '\n',
  );
  const seconds = Math.max(1, Math.ceil(params.timeoutSeconds));
  return ['timeout', '--kill-after=5s', `${String(seconds)}s`, '/bin/sh', '-c', script];
}

/** Prints the file size; exit 3 = missing, 4 = directory. Path passed as $1, never interpolated. */
export function buildStatArgv(path: string): string[] {
  return [
    '/bin/sh',
    '-c',
    `if [ ! -e "$1" ]; then exit ${String(STAT_EXIT_NOT_FOUND)}; fi; if [ -d "$1" ]; then exit ${String(STAT_EXIT_IS_DIR)}; fi; stat -c %s "$1"`,
    'sh',
    path,
  ];
}

export function buildCatArgv(path: string): string[] {
  return ['cat', '--', path];
}

/** Writes stdin to $1, creating parent directories. */
export function buildUploadArgv(remotePath: string): string[] {
  return ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', remotePath];
}

export function timeoutNote(exitCode: number, timeoutSeconds: number): string {
  return exitCode === EXEC_TIMEOUT_EXIT_CODE ? `\n[command timed out after ${String(Math.ceil(timeoutSeconds))}s]` : '';
}
```

- [ ] **Step 9: Run argv tests**

Run: same as Step 7. Expected: PASS.

- [ ] **Step 10: Write the fake cluster**

`FakeSandboxCluster.ts`:

```ts
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
  readonly shutdownUpdates: Array<{ name: string; shutdownTime: Date }> = [];
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
    this.running.set(manifest.metadata.name, { name: manifest.metadata.name, podIp: `10.0.0.${String(this.nextIp++)}` });
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
```

- [ ] **Step 11: Write failing provider tests**

`KubernetesSandboxProvider.test.ts`:

```ts
import { createLogger } from 'winston';
import { KubernetesSandboxProvider } from '../../../../../src/core/sandbox/provider/kubernetes/KubernetesSandboxProvider';
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
    expect(result).toEqual({ success: true, response: { exitCode: 124, result: 'partial\n[command timed out after 2s]' } });
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
    await expect(provider.exec({ sandboxId: 'other.tf-x', command: 'true' })).rejects.toBeInstanceOf(SandboxTenantMismatchError);
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
        return f ? { exitCode: 0, stdout: Buffer.from(`${String(f.length)}\n`) } : { exitCode: 3, stdout: Buffer.alloc(0) };
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
    const { provider } = setup();
    expect(provider.getToolResultDumpDir('default.tf-a')).toBe('/opt/tf/tool-results');
    expect(provider.getGitCredentialsPath('default.tf-a')).toBe('/opt/tf/.git-credentials');
    expect(provider.getFileUploadsDir('default.tf-a')).toBe('/opt/tf/uploads');
    expect(provider.getSkillsDir('default.tf-a')).toBe('/opt/tf/skills');
    expect(provider.getSkillDownloaderPath('default.tf-a')).toBe('/opt/tf/skill_downloader.py');
    expect(provider.getAdditionalInstructions()).toBeUndefined();
  });

  it('code mode transport installs the MCP client under /opt/tf', () => {
    const { provider } = setup();
    const install = provider.createCodeModeTransport().getClientInstall();
    expect(install.remotePath).toBe('/opt/tf/mcp-client/mcp_client.py');
  });
});
```

- [ ] **Step 12: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes/KubernetesSandboxProvider.test.ts`
Expected: FAIL — module not found. (If `SandboxTenantMismatchError` is not exported from `SandboxErrors.ts`, add `export` to its class declaration there — it is thrown by `validateSandboxOwnedByTenant` in the same file.)

- [ ] **Step 13: Implement the provider**

`KubernetesSandboxProvider.ts`:

```ts
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
      throw new Error(`Upload to ${params.remotePath} failed (exit ${String(result.exitCode)}): ${result.stdout.toString('utf-8')}`);
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
```

Note: the static `pods`/`lastExtended` maps are process-wide. Tests create fresh `tf-<uuid>` names per case, so they do not collide.

- [ ] **Step 14: Export from core**

In `packages/trueforge-core/src/core/index.ts`, directly after the `TFYSandboxProvider` export line, add:

```ts
export { KubernetesSandboxProvider } from './sandbox/provider/kubernetes/KubernetesSandboxProvider';
export type { KubernetesSandboxProviderOptions } from './sandbox/provider/kubernetes/KubernetesSandboxProvider';
export { ClusterExecTimeoutError } from './sandbox/provider/kubernetes/KubernetesSandboxCluster';
export type {
  ClusterExecParams,
  ClusterExecResult,
  KubernetesSandboxCluster,
  SandboxPod,
} from './sandbox/provider/kubernetes/KubernetesSandboxCluster';
export { buildSandboxManifest } from './sandbox/provider/kubernetes/sandboxManifest';
export type { SandboxManifest, SandboxResources } from './sandbox/provider/kubernetes/sandboxManifest';
```

- [ ] **Step 15: Run all kubernetes provider tests + typecheck + lint**

Run: `pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes && pnpm --filter @truefoundry/trueforge-core typecheck && pnpm exec eslint packages/trueforge-core/src/core/sandbox/provider/kubernetes packages/trueforge-core/tests/core/sandbox/provider/kubernetes`
Expected: all PASS, typecheck exit 0, no lint errors.

- [ ] **Step 16: Commit**

```bash
git add packages/trueforge-core/src/core/sandbox/provider/kubernetes packages/trueforge-core/src/core/index.ts packages/trueforge-core/src/core/sandbox/SandboxErrors.ts packages/trueforge-core/tests/core/sandbox/provider/kubernetes
git commit -m "feat(core): kubernetes sandbox provider backed by agent-sandbox

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Real cluster adapter (`@kubernetes/client-node`) + gated integration test

**Files:**
- Create: `packages/trueforge-core/src/core/sandbox/provider/kubernetes/ClientNodeSandboxCluster.ts`
- Modify: `packages/trueforge-core/src/core/index.ts` (add export)
- Test: `packages/trueforge-core/tests/core/sandbox/provider/kubernetes/cluster.it.test.ts`

**Interfaces:**
- Consumes: `KubernetesSandboxCluster`, `ClusterExecTimeoutError`, `SandboxManifest`, `SANDBOX_CONTAINER_NAME` from Task 2.
- Produces: `class ClientNodeSandboxCluster implements KubernetesSandboxCluster` with constructor `{ namespace: string; kubeConfig?: KubeConfig; pollIntervalMs?: number }` and static `ClientNodeSandboxCluster.fromEnvironment(namespace: string)` (in-cluster when `KUBERNETES_SERVICE_HOST` is set, else default kubeconfig).

- [ ] **Step 1: Prerequisite — agent-sandbox controller on the homelab**

The integration test needs the CRD/controller. Do **Task 7 Step 1** (deploy `components/agent-sandbox`) now, then create a throwaway test namespace and grab a kubeconfig reachable over Tailscale:

```bash
ssh vishal@100.89.163.21 'kubectl create namespace trueforge-sandbox-it --dry-run=client -o yaml | kubectl apply -f -'
scp vishal@100.89.163.21:/home/vishal/.kube/config /tmp/homelab-kubeconfig
sed -i '' 's#server: https://[^:]*:6443#server: https://100.89.163.21:6443#' /tmp/homelab-kubeconfig
KUBECONFIG=/tmp/homelab-kubeconfig kubectl get crd sandboxes.agents.x-k8s.io
```
Expected: the CRD is listed. If TLS fails because the API cert lacks the Tailscale IP, add `insecure-skip-tls-verify: true` under the cluster entry of `/tmp/homelab-kubeconfig` (test-only file, deleted in Step 6).

- [ ] **Step 2: Write the gated integration test**

`cluster.it.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `KUBE_SANDBOX_IT=1 KUBECONFIG=/tmp/homelab-kubeconfig pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes/cluster.it.test.ts`
Expected: FAIL — `Cannot find module '.../ClientNodeSandboxCluster'`.

- [ ] **Step 4: Implement the adapter**

`ClientNodeSandboxCluster.ts`:

```ts
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
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
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
        if (settled) return;
        settled = true;
        socket?.close();
        reject(new ClusterExecTimeoutError(params.timeoutMs));
      }, params.timeoutMs);

      this.execApi
        .exec(this.namespace, params.name, SANDBOX_CONTAINER_NAME, params.argv, stdout, stderr, stdin, false, status => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve({ exitCode: exitCodeFromStatus(status), stdout: Buffer.concat(chunks) });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        })
        .then(ws => {
          socket = ws;
          if (settled) ws.close();
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }
}
```

- [ ] **Step 5: Export and run the integration test**

Add to `packages/trueforge-core/src/core/index.ts` after the Task 2 exports:

```ts
export { ClientNodeSandboxCluster } from './sandbox/provider/kubernetes/ClientNodeSandboxCluster';
```

Run: `KUBE_SANDBOX_IT=1 KUBECONFIG=/tmp/homelab-kubeconfig pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes/cluster.it.test.ts`
Expected: 6 PASS. The test namespace has no NetworkPolicy/quota — that is fine for this adapter test. If stdout arrives after the status callback (empty/partial `result`), fix by resolving on the websocket `close` event instead of inside the status callback (store the exit code from the callback, resolve in `ws.on('close')`), then re-run.

Also run without the flag to prove it skips in normal CI: `pnpm --filter @truefoundry/trueforge-core exec jest --config jest.config.cjs tests/core/sandbox/provider/kubernetes` → cluster suite reported as skipped, others PASS.

- [ ] **Step 6: Clean up and commit**

```bash
ssh vishal@100.89.163.21 'kubectl delete namespace trueforge-sandbox-it'
rm -f /tmp/homelab-kubeconfig
git add packages/trueforge-core/src/core/sandbox/provider/kubernetes/ClientNodeSandboxCluster.ts packages/trueforge-core/src/core/index.ts packages/trueforge-core/tests/core/sandbox/provider/kubernetes/cluster.it.test.ts
git commit -m "feat(core): client-node cluster adapter for kubernetes sandboxes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Server wiring (env config, managed store, provider construction, managed endpoint)

**Files:**
- Create: `packages/trueforge/src/sandbox/kubernetes/kubernetesSandboxConfig.ts`
- Create: `packages/trueforge/src/sandbox/kubernetes/KubernetesSandboxProviderStore.ts`
- Modify: `packages/trueforge/src/schemas/sandboxProvider.ts` (stored union, lines ~56-73)
- Modify: `packages/trueforge/src/sandbox/providerUtils.ts` (`toSandboxProviderFromRecord` switch; `checkSnapshotStatus` early return)
- Modify: `packages/trueforge/src/main.ts` (`buildResolveSandboxProviderStore`, ~line 278)
- Modify: `packages/trueforge/src/apis/sandboxProviders.ts` (add `GET /managed`)
- Test: `packages/trueforge/tests/unit/sandbox/kubernetes/kubernetesSandboxConfig.test.ts`
- Test: `packages/trueforge/tests/unit/sandbox/kubernetes/KubernetesSandboxProviderStore.test.ts`
- Test: `packages/trueforge/tests/unit/apis/sandboxProvidersManaged.test.ts`

**Interfaces:**
- Consumes: `KubernetesSandboxProvider`, `ClientNodeSandboxCluster` (Tasks 2–3) from `@truefoundry/trueforge-core/core`.
- Produces:
  - `readKubernetesSandboxConfig(env?: NodeJS.ProcessEnv): KubernetesSandboxConfig | undefined` where `KubernetesSandboxConfig = { namespace: string; image: string; idleTtlMinutes: number; execTimeoutMs: number; runtimeClassName: string | undefined }`
  - `KubernetesSandboxProviderSchema` (zod) with `{ type: 'kubernetes', namespace, image, exec_timeout_ms, idle_ttl_minutes, runtime_class_name: string | null }`
  - `class KubernetesSandboxProviderStore<T> implements ISandboxProviderStore<T>`
  - HTTP `GET /api/v1/settings/sandbox-providers/managed` → `200 { data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: string, status: 'ready' } }` or `404`.

- [ ] **Step 1: Failing test for env config**

`kubernetesSandboxConfig.test.ts`:

```ts
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
    ).toEqual({ namespace: 'sb', image: 'img', idleTtlMinutes: 15, execTimeoutMs: 120_000, runtimeClassName: 'gvisor' });
  });

  it('fails fast on a missing image or bad numbers', () => {
    expect(() => readKubernetesSandboxConfig({ KUBERNETES_SANDBOX_ENABLED: 'true' })).toThrow('KUBERNETES_SANDBOX_IMAGE');
    expect(() =>
      readKubernetesSandboxConfig({ KUBERNETES_SANDBOX_ENABLED: 'true', KUBERNETES_SANDBOX_IMAGE: 'i', KUBERNETES_SANDBOX_IDLE_TTL_MINUTES: '0' }),
    ).toThrow('KUBERNETES_SANDBOX_IDLE_TTL_MINUTES');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge test -- tests/unit/sandbox/kubernetes/kubernetesSandboxConfig.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement config**

`kubernetesSandboxConfig.ts`:

```ts
import { z } from 'zod';

export interface KubernetesSandboxConfig {
  namespace: string;
  image: string;
  idleTtlMinutes: number;
  execTimeoutMs: number;
  runtimeClassName: string | undefined;
}

const positiveInt = (name: string) =>
  z.coerce.number({ error: `${name} must be a positive integer` }).int(`${name} must be a positive integer`).positive(`${name} must be a positive integer`);

const Schema = z.object({
  KUBERNETES_SANDBOX_NAMESPACE: z.string().min(1).default('trueforge-sandboxes'),
  KUBERNETES_SANDBOX_IMAGE: z.string({ error: 'KUBERNETES_SANDBOX_IMAGE is required when KUBERNETES_SANDBOX_ENABLED=true' }).min(1, 'KUBERNETES_SANDBOX_IMAGE is required when KUBERNETES_SANDBOX_ENABLED=true'),
  KUBERNETES_SANDBOX_IDLE_TTL_MINUTES: positiveInt('KUBERNETES_SANDBOX_IDLE_TTL_MINUTES').default(60),
  KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS: positiveInt('KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS').default(60_000),
  KUBERNETES_SANDBOX_RUNTIME_CLASS: z.string().min(1).optional(),
});

/** Server-managed Kubernetes sandbox settings; undefined unless KUBERNETES_SANDBOX_ENABLED=true. */
export function readKubernetesSandboxConfig(env: NodeJS.ProcessEnv = process.env): KubernetesSandboxConfig | undefined {
  if (env['KUBERNETES_SANDBOX_ENABLED']?.trim().toLowerCase() !== 'true') {
    return undefined;
  }
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid Kubernetes sandbox configuration: ${parsed.error.issues.map(i => i.message).join('; ')}`);
  }
  const c = parsed.data;
  return {
    namespace: c.KUBERNETES_SANDBOX_NAMESPACE,
    image: c.KUBERNETES_SANDBOX_IMAGE,
    idleTtlMinutes: c.KUBERNETES_SANDBOX_IDLE_TTL_MINUTES,
    execTimeoutMs: c.KUBERNETES_SANDBOX_EXEC_TIMEOUT_MS,
    runtimeClassName: c.KUBERNETES_SANDBOX_RUNTIME_CLASS,
  };
}
```

- [ ] **Step 4: Run config tests**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Add the stored schema**

In `packages/trueforge/src/schemas/sandboxProvider.ts`, after `TrueFoundrySandboxProviderSchema`, add:

```ts
/** Server-managed Kubernetes (agent-sandbox) config — env-synthesized store records only. Not in OpenAPI. */
export const KubernetesSandboxProviderSchema = z
  .object({
    type: z.literal('kubernetes').describe('Kubernetes (agent-sandbox) sandbox provider.'),
    namespace: z.string().min(1).describe('Namespace sandboxes run in.'),
    image: z.string().min(1).describe('Sandbox container image.'),
    exec_timeout_ms: z.number().int().positive().describe('Default sandbox command exec timeout in milliseconds.'),
    idle_ttl_minutes: z.number().int().positive().describe('Idle minutes before a sandbox is deleted.'),
    runtime_class_name: z.string().nullable().describe('Pod runtimeClassName (e.g. gvisor); null for the default runtime.'),
  })
  .strict();
```

Change the stored union to:

```ts
export const StoredSandboxProviderManifestSchema = z.discriminatedUnion('type', [
  DaytonaSandboxProviderSchema,
  TrueFoundrySandboxProviderSchema,
  KubernetesSandboxProviderSchema,
]);
```

And add next to the other exported types:

```ts
export type KubernetesSandboxProviderManifest = z.infer<typeof KubernetesSandboxProviderSchema>;
```

- [ ] **Step 6: Failing store test**

`KubernetesSandboxProviderStore.test.ts`:

```ts
import { HTTPException } from 'hono/http-exception';
import { KubernetesSandboxProviderStore } from '../../../../src/sandbox/kubernetes/KubernetesSandboxProviderStore';

const config = {
  namespace: 'trueforge-sandboxes',
  image: 'ghcr.io/x/sb:v1',
  idleTtlMinutes: 60,
  execTimeoutMs: 60_000,
  runtimeClassName: undefined,
};

describe('KubernetesSandboxProviderStore', () => {
  it('synthesizes a ready kubernetes record for any tenant', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    const record = await store.getSandboxProvider('default');
    expect(record).toMatchObject({
      tenant_id: 'default',
      manifest: {
        type: 'kubernetes',
        namespace: 'trueforge-sandboxes',
        image: 'ghcr.io/x/sb:v1',
        exec_timeout_ms: 60_000,
        idle_ttl_minutes: 60,
        runtime_class_name: null,
      },
      status: 'ready',
      status_reason: null,
      build_metadata: { image_uri: 'ghcr.io/x/sb:v1' },
    });
  });

  it('rejects writes as server-managed (409)', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    await expect(store.getSandboxProviderForUpdate('default', undefined as never)).rejects.toMatchObject({ status: 409 });
    await expect(store.upsertSandboxProvider({} as never)).rejects.toBeInstanceOf(HTTPException);
  });

  it('status updates are a no-op returning the synthesized record', async () => {
    const store = new KubernetesSandboxProviderStore(config);
    const updated = await store.updateSandboxStatus({ tenant_id: 'default', status: 'failed', status_reason: 'x', build_metadata: null });
    expect(updated?.status).toBe('ready');
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge test -- tests/unit/sandbox/kubernetes/KubernetesSandboxProviderStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement the store**

`KubernetesSandboxProviderStore.ts`:

```ts
import { HTTPException } from 'hono/http-exception';
import type {
  ISandboxProviderStore,
  SandboxProviderRecord,
  UpdateSandboxStatusInput,
  UpsertSandboxProviderInput,
} from '../../db/sandboxProviderStore';
import type { KubernetesSandboxConfig } from './kubernetesSandboxConfig';

export const KUBERNETES_MANAGED_MESSAGE =
  'The sandbox provider is managed by server configuration (Kubernetes); change it in the deployment, not here.';

function managed(): never {
  throw new HTTPException(409, { message: KUBERNETES_MANAGED_MESSAGE });
}

/** Env-backed shared Kubernetes sandbox for every tenant; settings writes are rejected. */
export class KubernetesSandboxProviderStore<TTransaction = never> implements ISandboxProviderStore<TTransaction> {
  constructor(private readonly config: KubernetesSandboxConfig) {}

  private record(tenantId: string): SandboxProviderRecord {
    const now = new Date().toISOString();
    return {
      tenant_id: tenantId,
      manifest: {
        type: 'kubernetes',
        namespace: this.config.namespace,
        image: this.config.image,
        exec_timeout_ms: this.config.execTimeoutMs,
        idle_ttl_minutes: this.config.idleTtlMinutes,
        runtime_class_name: this.config.runtimeClassName ?? null,
      },
      status: 'ready',
      status_reason: null,
      build_metadata: { image_uri: this.config.image },
      created_at: now,
      updated_at: now,
    };
  }

  getSandboxProvider(tenantId: string, transaction?: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void transaction;
    return Promise.resolve(this.record(tenantId));
  }

  getSandboxProviderForUpdate(tenantId: string, transaction: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void tenantId;
    void transaction;
    return Promise.reject(new HTTPException(409, { message: KUBERNETES_MANAGED_MESSAGE }));
  }

  upsertSandboxProvider(input: UpsertSandboxProviderInput, transaction?: TTransaction): Promise<SandboxProviderRecord> {
    void input;
    void transaction;
    return Promise.resolve().then(managed);
  }

  updateSandboxStatus(input: UpdateSandboxStatusInput, transaction?: TTransaction): Promise<SandboxProviderRecord | undefined> {
    void transaction;
    return Promise.resolve(this.record(input.tenant_id));
  }
}
```

If `SandboxProviderRecord` has fields beyond those used here (check `packages/trueforge/src/db/sandboxProviderStore.ts:13-26`), copy their shape from `synthesizeTrueFoundryRecord` in `src/truefoundry/TrueFoundrySandboxProviderStore.ts`, which is the reference implementation of this pattern.

- [ ] **Step 9: Run store tests**

Run: same as Step 7. Expected: PASS.

- [ ] **Step 10: Construct the provider from a kubernetes record**

In `packages/trueforge/src/sandbox/providerUtils.ts`:

Add to the `@truefoundry/trueforge-core/core` import: `ClientNodeSandboxCluster, KubernetesSandboxProvider`.

Add below the imports:

```ts
/** One cluster client per namespace for the process (kubeconfig/SA token loaded once). */
const clusterByNamespace = new Map<string, ClientNodeSandboxCluster>();

function clusterFor(namespace: string): ClientNodeSandboxCluster {
  let cluster = clusterByNamespace.get(namespace);
  if (!cluster) {
    cluster = ClientNodeSandboxCluster.fromEnvironment(namespace);
    clusterByNamespace.set(namespace, cluster);
  }
  return cluster;
}
```

Add a case to the `switch (record.manifest.type)` in `toSandboxProviderFromRecord`:

```ts
    case 'kubernetes':
      return new KubernetesSandboxProvider({
        cluster: clusterFor(record.manifest.namespace),
        namespace: record.manifest.namespace,
        tenantName: tenant_id,
        sandboxImage: record.manifest.image,
        defaultExecTimeoutMs: record.manifest.exec_timeout_ms,
        idleTtlMinutes: record.manifest.idle_ttl_minutes,
        runtimeClassName: record.manifest.runtime_class_name ?? undefined,
        fileMaxBytesForDownload: configuration.SANDBOX_FILE_MAX_BYTES_FOR_DOWNLOAD,
        logger,
      });
```

In `checkSnapshotStatus`, change the early return to:

```ts
  // Prebuilt images — no snapshot registration or refresh.
  if (record.manifest.type === 'truefoundry' || record.manifest.type === 'kubernetes') {
    return persisted;
  }
```

Run: `pnpm --filter @truefoundry/trueforge typecheck`
Expected: exit 0. Any other `switch (…manifest.type)` that is now non-exhaustive will be reported here — for each, treat `'kubernetes'` exactly like `'truefoundry'` (both are env-synthesized, prebuilt-image providers) and re-run until clean.

- [ ] **Step 11: Wire the store resolver**

In `packages/trueforge/src/main.ts`, import `readKubernetesSandboxConfig` and `KubernetesSandboxProviderStore`, and make `buildResolveSandboxProviderStore` check it first:

```ts
function buildResolveSandboxProviderStore<TTransaction>(options: {
  persistenceStore: ISandboxProviderStore<TTransaction>;
}): (rc: RequestContext) => ISandboxProviderStore<TTransaction> {
  const { persistenceStore } = options;
  const kubernetesSandbox = configuration.STANDALONE ? undefined : readKubernetesSandboxConfig();
  if (kubernetesSandbox) {
    const store = new KubernetesSandboxProviderStore<TTransaction>(kubernetesSandbox);
    return () => store;
  }
  if (isTrueFoundryModeEnabled(configuration)) {
    return () => new TrueFoundrySandboxProviderStore<TTransaction>();
  }
  return () => persistenceStore;
}
```

- [ ] **Step 12: Failing test for the managed endpoint and PUT rejection**

`sandboxProvidersManaged.test.ts` — build the router directly with the kubernetes store (follow the harness in `tests/unit/apis/sandboxProviders.test.ts` for `resolveRequestContext`/`withTransaction` stubs):

```ts
import { createLogger } from 'winston';
import { createSandboxProvidersRouter } from '../../../src/apis/sandboxProviders';
import { KubernetesSandboxProviderStore } from '../../../src/sandbox/kubernetes/KubernetesSandboxProviderStore';

const store = new KubernetesSandboxProviderStore({
  namespace: 'trueforge-sandboxes',
  image: 'ghcr.io/x/sb:v1',
  idleTtlMinutes: 60,
  execTimeoutMs: 60_000,
  runtimeClassName: undefined,
});

function router() {
  return createSandboxProvidersRouter({
    resolveSandboxProviderStore: () => store,
    withTransaction: async fn => fn(undefined as never),
    logger: createLogger({ silent: true }),
    resolveRequestContext: () => ({ tenant_id: 'default' }) as never,
  });
}

describe('sandbox providers — kubernetes managed', () => {
  it('GET /managed describes the managed provider', async () => {
    const res = await router().request('/managed');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: 'trueforge-sandboxes', status: 'ready' },
    });
  });

  it('GET / stays 404 (settings form is Daytona-only)', async () => {
    const res = await router().request('/');
    expect(res.status).toBe(404);
  });

  it('PUT / is rejected with 409', async () => {
    const res = await router().request('/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manifest: {
          type: 'daytona',
          auth: { api_key: 'k' },
          exec_timeout_ms: 1,
          auto_stop_interval_in_minutes: 1,
          auto_archive_interval_in_minutes: 1,
          auto_delete_interval_in_minutes: 1,
        },
      }),
    });
    expect(res.status).toBe(409);
  });
});
```

Also add a sanity case proving a Daytona store still 404s on `/managed`:

```ts
  it('GET /managed is 404 for non-managed stores', async () => {
    const r = createSandboxProvidersRouter({
      resolveSandboxProviderStore: () => ({ getSandboxProvider: () => Promise.resolve(undefined) }) as never,
      withTransaction: async fn => fn(undefined as never),
      logger: createLogger({ silent: true }),
      resolveRequestContext: () => ({ tenant_id: 'default' }) as never,
    });
    expect((await r.request('/managed')).status).toBe(404);
  });
```

- [ ] **Step 13: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge test -- tests/unit/apis/sandboxProvidersManaged.test.ts`
Expected: FAIL — `/managed` returns 404 in the first case.

- [ ] **Step 14: Add the endpoint**

In `packages/trueforge/src/apis/sandboxProviders.ts`, before `const router = new OpenAPIHono();`, add:

```ts
  /** Read-only view of a server-managed provider (Kubernetes); 404 when settings are tenant-managed. */
  const managedHandler = async (c: Context) => {
    const requestContext = deps.resolveRequestContext(c);
    const record = await deps.resolveSandboxProviderStore(c).getSandboxProvider(requestContext.tenant_id);
    if (record?.manifest.type !== 'kubernetes') {
      return c.json({ error: { message: 'No server-managed sandbox provider' } }, 404);
    }
    return c.json(
      { data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: record.manifest.namespace, status: record.status } },
      200,
    );
  };
```

and register it **before** the openapi routes:

```ts
  const router = new OpenAPIHono();
  router.get('/managed', managedHandler);
  router.openapi(getSandboxProviderRoute, getHandler);
  router.openapi(putSandboxProviderRoute, putHandler);
  return router;
```

The PUT 409 needs no change: `getSandboxProviderForUpdate` throws the `HTTPException(409)` inside `withTransaction`, which the app's error handler maps to a 409 response. If the test shows a 500 instead, the router under test lacks the app's `onError`; add `router.onError((err, c) => err instanceof HTTPException ? err.getResponse() : c.json({ error: { message: 'Internal error' } }, 500))` in the test's `router()` helper only — do not change production error handling.

- [ ] **Step 15: Run server tests + typecheck + lint**

Run: `pnpm --filter @truefoundry/trueforge test -- tests/unit/sandbox tests/unit/apis tests/unit/schemas && pnpm --filter @truefoundry/trueforge typecheck && pnpm exec eslint packages/trueforge/src/sandbox packages/trueforge/src/apis/sandboxProviders.ts packages/trueforge/src/main.ts`
Expected: all PASS (existing Daytona/TrueFoundry tests unaffected), typecheck 0, lint clean.

- [ ] **Step 16: Commit**

```bash
git add packages/trueforge/src packages/trueforge/tests/unit
git commit -m "feat(server): server-managed kubernetes sandbox provider

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Settings UI shows the managed provider read-only

**Files:**
- Modify: `packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/catalogs/sandboxProviderCatalog.ts`
- Modify: `packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/index.ts:95-103`
- Modify: `packages/trueforge-ui/src/containers/SettingsBuilder/SandboxSettings.tsx` (configured-row actions)
- Test: `packages/trueforge-ui/test/plugins/trueforge-agent-server-adapter/catalogs/sandboxProviderCatalog.test.ts`
- Test: `packages/trueforge-ui/test/containers/SettingsBuilder/SandboxSettings.test.tsx`

**Interfaces:**
- Consumes: `GET /api/v1/settings/sandbox-providers/managed` (Task 4).
- Produces: `createSandboxProviderCatalog(client: TrueForge, http?: ManagedProviderHttp)` where `interface ManagedProviderHttp { baseUrl: string; fetch: typeof fetch; token?: string }`; `UiSandboxProvider` gains optional `managed?: boolean`.

- [ ] **Step 1: Failing adapter test**

Append to `sandboxProviderCatalog.test.ts` (reuse its existing fake-client helper for `client`; if none exists, cast `{ settings: { sandboxProviders: { get: jest.fn() } }, catalogs: { sandboxProviders: { list: jest.fn() } } } as never`):

```ts
describe('managed kubernetes provider', () => {
  const managedBody = { data: { type: 'kubernetes', name: 'Kubernetes (homelab)', namespace: 'trueforge-sandboxes', status: 'ready' } };

  function http(status: number, body: unknown) {
    return {
      baseUrl: 'https://tf.example/',
      fetch: jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    };
  }

  it('lists the managed provider as connected and read-only, and hides the catalog', async () => {
    const client = {
      settings: { sandboxProviders: { get: jest.fn() } },
      catalogs: { sandboxProviders: { list: jest.fn(async () => ({ data: [{ type: 'daytona', execTimeoutMs: 1, autoStopIntervalInMinutes: 1, autoArchiveIntervalInMinutes: 1, autoDeleteIntervalInMinutes: 1 }] })) } },
    } as never;
    const h = http(200, managedBody);
    const catalog = createSandboxProviderCatalog(client, h);
    await expect(catalog.listSandboxProviders()).resolves.toEqual([
      {
        data: expect.objectContaining({ id: 'kubernetes', name: 'Kubernetes (homelab)', catalogId: 'kubernetes', isConnected: true, managed: true }),
        snapshotSyncStatus: { status: 'ready' },
      },
    ]);
    await expect(catalog.getSandboxProviderCatalog()).resolves.toEqual([]);
    expect(h.fetch).toHaveBeenCalledWith('https://tf.example/api/v1/settings/sandbox-providers/managed', expect.anything());
  });

  it('falls back to the Daytona flow when /managed is 404', async () => {
    const get = jest.fn(async () => {
      throw new TrueForgeApi.NotFoundError({});
    });
    const client = { settings: { sandboxProviders: { get } }, catalogs: { sandboxProviders: { list: jest.fn(async () => ({ data: [] })) } } } as never;
    const catalog = createSandboxProviderCatalog(client, http(404, { error: { message: 'x' } }));
    await expect(catalog.listSandboxProviders()).resolves.toEqual([]);
    expect(get).toHaveBeenCalled();
  });
});
```

(Import `TrueForgeApi` from `@truefoundry/trueforge-sdk` at the top if the file does not already.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge-ui test -- sandboxProviderCatalog`
Expected: FAIL — `createSandboxProviderCatalog` ignores the second argument; list returns the Daytona path.

- [ ] **Step 3: Implement the adapter change**

In `sandboxProviderCatalog.ts`:

Extend the UI type:

```ts
export type UiSandboxProvider = SandboxProviderBase & DaytonaSandboxConfig & { managed?: boolean };
```

Add:

```ts
/** Plain HTTP access for endpoints not in the generated SDK. */
export interface ManagedProviderHttp {
  baseUrl: string;
  fetch: typeof fetch;
  token?: string | undefined;
}

interface ManagedProviderResponse {
  data: { type: string; name: string; namespace: string; status: 'pending' | 'ready' | 'failed' };
}

const MANAGED_CONFIG: DaytonaSandboxConfig = {
  execTimeoutMs: 0,
  autoStopIntervalInMinutes: 0,
  autoArchiveIntervalInMinutes: 0,
  autoDeleteIntervalInMinutes: 0,
};

async function fetchManagedProvider(http: ManagedProviderHttp): Promise<UiSandboxProviderListEntry | undefined> {
  const url = new URL('api/v1/settings/sandbox-providers/managed', http.baseUrl.endsWith('/') ? http.baseUrl : `${http.baseUrl}/`);
  const response = await http.fetch(url.toString(), {
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
  return {
    data: {
      id: body.data.type,
      name: body.data.name,
      catalogId: body.data.type,
      isConnected: true,
      managed: true,
      ...MANAGED_CONFIG,
    },
    snapshotSyncStatus: { status: body.data.status },
  };
}
```

Change the factory signature and the two list methods:

```ts
export function createSandboxProviderCatalog(client: TrueForge, http?: ManagedProviderHttp): DaytonaSandboxCatalogServer {
```

```ts
    getSandboxProviderCatalog: async () => {
      if (http && (await fetchManagedProvider(http))) {
        return [];
      }
      const body = await client.catalogs.sandboxProviders.list();
      return body.data.map(toUiCatalogEntry);
    },
    listSandboxProviders: async req => {
      const managed = http ? await fetchManagedProvider(http) : undefined;
      if (managed) {
        return filterUiSandboxProviders({ providers: [managed], query: req?.query });
      }
      let providers: UiSandboxProviderListEntry[];
      // …existing Daytona body unchanged…
```

In `packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter/index.ts`, import `resolveTrueForgeBaseUrl` from `./client.js` and pass HTTP options:

```ts
      sandboxCatalog: createSandboxProviderCatalog(client, {
        baseUrl: resolveTrueForgeBaseUrl(clientOptions.baseUrl ?? '/'),
        fetch: clientOptions.fetch ?? globalThis.fetch.bind(globalThis),
        token: clientOptions.token,
      }),
```

- [ ] **Step 4: Run adapter tests**

Run: same as Step 2. Expected: PASS (new + existing).

- [ ] **Step 5: Failing component test — no Update/Retry for managed rows**

Append to `SandboxSettings.test.tsx`, using the file's existing render helper that injects a `sandboxCatalog` into the catalog server context:

```tsx
it('renders a managed provider read-only', async () => {
  renderWithSandboxCatalog({
    listSandboxProviders: async () => [
      {
        data: { id: 'kubernetes', name: 'Kubernetes (homelab)', catalogId: 'kubernetes', isConnected: true, managed: true, execTimeoutMs: 0, autoStopIntervalInMinutes: 0, autoArchiveIntervalInMinutes: 0, autoDeleteIntervalInMinutes: 0 },
        snapshotSyncStatus: { status: 'ready' },
      },
    ],
    getSandboxProviderCatalog: async () => [],
    createSandboxProvider: jest.fn(),
    updateSandboxProvider: jest.fn(),
  });
  expect(await screen.findByText('Kubernetes (homelab)')).toBeInTheDocument();
  expect(screen.getByText('Connected')).toBeInTheDocument();
  expect(screen.getByText('Managed by server')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
});
```

If the test file's helper has a different name, use that helper — do not add a second rendering setup.

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @truefoundry/trueforge-ui test -- SandboxSettings`
Expected: FAIL — `Managed by server` not found / Update button present.

- [ ] **Step 7: Implement the component change**

In `SandboxSettings.tsx`, inside the configured-row map, compute `const isManaged = 'managed' in provider && provider.managed === true;` and:
- Wrap the `Retry` button, the `Update` button, and the `Remove` button conditions with `!isManaged &&`.
- After `{statusIndicator}`, render:

```tsx
                          {isManaged ? (
                            <span className="text-xs text-text-secondary">Managed by server</span>
                          ) : null}
```

- [ ] **Step 8: Run UI tests, typecheck, lint**

Run: `pnpm --filter @truefoundry/trueforge-ui test && pnpm --filter @truefoundry/trueforge-ui typecheck && pnpm exec eslint packages/trueforge-ui/src/containers/SettingsBuilder/SandboxSettings.tsx packages/trueforge-ui/src/plugins/trueforge-agent-server-adapter`
Expected: PASS / 0 / clean.

- [ ] **Step 9: Commit**

```bash
git add packages/trueforge-ui
git commit -m "feat(ui): read-only managed kubernetes sandbox provider row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Images and CI (server from source + non-root sandbox image)

**Files:**
- Create: `deploy/homelab/sandbox.Dockerfile`, `deploy/homelab/supervisord.conf`, `deploy/homelab/nats.supervisor.conf`
- Create/Modify: `.github/workflows/` (via skill) + `.github/workflows/homelab-sandbox-image.yml`

**Interfaces:**
- Consumes: upstream `packages/trueforge-core/scripts/sandbox/{sandbox.Dockerfile,nats.conf}`; `Dockerfile.dev` (from-source server image).
- Produces: `ghcr.io/vishal-pandey/trueforge:<vX.Y.Z>` (server) and `ghcr.io/vishal-pandey/trueforge-sandbox:<vX.Y.Z>` (sandbox), both also `:latest`.

- [ ] **Step 1: Write the non-root sandbox image**

`deploy/homelab/sandbox.Dockerfile` (build context = repo root):

```dockerfile
# Homelab sandbox: upstream release sandbox toolchain, run as uid 1000 (non-root).
FROM python:3.13-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ARG NATS_SERVER_VERSION="v2.14.2"
ARG HELM_VERSION="v4.2.3"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep supervisor tree unzip zip procps \
  && curl -fsSL https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz | tar -xz -C /tmp \
  && mv /tmp/linux-amd64/helm /usr/local/bin/helm && rm -rf /tmp/linux-amd64 \
  && curl -fsSL https://github.com/nats-io/nats-server/releases/download/${NATS_SERVER_VERSION}/nats-server-${NATS_SERVER_VERSION}-linux-amd64.tar.gz | tar -xz -C /tmp \
  && mv /tmp/nats-server-${NATS_SERVER_VERSION}-linux-amd64/nats-server /usr/local/bin/nats-server \
  && rm -rf /tmp/nats-server-* \
  && python -m pip install --no-cache-dir --upgrade pip \
  && python -m pip install --no-cache-dir \
     aiohttp==3.14.1 genson==1.3.0 mcp==1.29.0 nats-py==2.15.0 openpyxl==3.1.5 pandas==3.0.5 pydantic==2.12.5 requests==2.33.1 \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 trueforge \
  && useradd --uid 1000 --gid 1000 --home-dir /home/trueforge --create-home --shell /bin/bash trueforge \
  && mkdir -p /opt/tf/bin /opt/tf/uploads /opt/tf/skills /opt/tf/tool-results /opt/tf/mcp-client /var/lib/nats /var/log/supervisor /var/run/supervisor \
  && chown -R 1000:1000 /opt/tf /var/lib/nats /var/log/supervisor /var/run/supervisor /home/trueforge

COPY packages/trueforge-core/scripts/sandbox/nats.conf /var/lib/nats/nats.conf
COPY deploy/homelab/supervisord.conf /etc/supervisor/supervisord.conf
COPY deploy/homelab/nats.supervisor.conf /etc/supervisor/conf.d/nats.conf

USER 1000:1000
ENV HOME=/home/trueforge \
    PATH=/opt/tf/bin:/home/trueforge/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PIP_USER=1
RUN git config --global user.email "trueforge@example.org" && git config --global user.name "TrueForge Agent"
WORKDIR /home/trueforge
EXPOSE 4444
ENTRYPOINT ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
```

`deploy/homelab/supervisord.conf`:

```ini
[unix_http_server]
file=/var/run/supervisor/supervisor.sock

[supervisord]
logfile=/var/log/supervisor/supervisord.log
pidfile=/var/run/supervisor/supervisord.pid
nodaemon=true

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///var/run/supervisor/supervisor.sock

[include]
files = /etc/supervisor/conf.d/*.conf
```

`deploy/homelab/nats.supervisor.conf`:

```ini
[program:nats]
command=/usr/local/bin/nats-server -c /var/lib/nats/nats.conf
directory=/var/lib/nats
autostart=true
autorestart=true
startretries=3
startsecs=5
stopsignal=TERM
stopwaitsecs=10
killasgroup=true
stopasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

- [ ] **Step 2: Server image CI via the skill**

Invoke the `homelab-host:github-action-ci-setup` skill for `vishal-pandey/trueforge` with image name `trueforge`, Dockerfile `Dockerfile.dev`, context `.`. Do not hand-write this workflow. Confirm the generated workflow builds `Dockerfile.dev` (edit only the `file:` input of the build step if the skill defaulted to `./Dockerfile`).

- [ ] **Step 3: Sandbox image workflow**

`.github/workflows/homelab-sandbox-image.yml`:

```yaml
name: homelab-sandbox-image

on:
  push:
    branches: [main]
    paths:
      - 'deploy/homelab/**'
      - 'packages/trueforge-core/scripts/sandbox/nats.conf'
      - '.github/workflows/homelab-sandbox-image.yml'
  workflow_dispatch: {}

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: deploy/homelab/sandbox.Dockerfile
          push: true
          labels: org.opencontainers.image.source=https://github.com/${{ github.repository }}
          tags: |
            ghcr.io/${{ github.repository_owner }}/trueforge-sandbox:sha-${{ github.sha }}
            ghcr.io/${{ github.repository_owner }}/trueforge-sandbox:latest
```

- [ ] **Step 4: Push and watch both builds**

```bash
git add deploy/homelab .github/workflows
git commit -m "ci: homelab server + non-root sandbox images to GHCR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin main
gh run list --repo vishal-pandey/trueforge --limit 4
gh run watch --repo vishal-pandey/trueforge $(gh run list --repo vishal-pandey/trueforge --workflow homelab-sandbox-image.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: both workflows succeed; `gh release list --repo vishal-pandey/trueforge` shows a `vX.Y.Z` release (server CI); packages `trueforge` and `trueforge-sandbox` exist in GHCR.

- [ ] **Step 5: Verify the homelab can pull both images**

```bash
ssh vishal@100.89.163.21 'T=$(cat /home/vishal/.githubtoken); for img in trueforge trueforge-sandbox; do PT=$(curl -s -u "x:$T" "https://ghcr.io/token?service=ghcr.io&scope=repository:vishal-pandey/$img:pull" | jq -r .token); echo "$img $(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $PT" https://ghcr.io/v2/vishal-pandey/$img/tags/list)"; done'
```
Expected: `trueforge 200` and `trueforge-sandbox 200`.

---

### Task 7: Homelab infrastructure and cutover

**Files (on the server, `/home/vishal/argocd-apps`):**
- Create: `components/agent-sandbox/{kustomization.yaml,sandbox.yaml}`, `apps/templates/business/agent-sandbox.yaml`
- Create: `components/trueforge-sandboxes/{kustomization.yaml,namespace.yaml,networkpolicy.yaml,quota.yaml,rbac.yaml,ghcr-pull-secret.yaml}`, `apps/templates/business/trueforge-sandboxes.yaml`
- Modify: `components/trueforge/{deployment.yaml,controller.yaml,kustomization.yaml}`, create `components/trueforge/serviceaccount.yaml`, `components/trueforge/ghcr-pull-secret.yaml`

**Interfaces:**
- Consumes: images from Task 6; provider env names from Task 4.
- Produces: live TrueForge using Kubernetes sandboxes.

- [ ] **Step 1: Deploy the agent-sandbox controller (also the Task 3 prerequisite)**

```bash
ssh vishal@100.89.163.21 'cd /home/vishal/argocd-apps && mkdir -p components/agent-sandbox && \
  curl -fsSL https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.3/sandbox.yaml -o components/agent-sandbox/sandbox.yaml && \
  printf "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - sandbox.yaml\n" > components/agent-sandbox/kustomization.yaml'
```

`apps/templates/business/agent-sandbox.yaml`: the standard ArgoCD `Application` from the host-app skill with `name: agent-sandbox`, `path: components/agent-sandbox`, `destination.namespace: agent-sandbox-system`, plus `syncOptions: [CreateNamespace=true, ServerSideApply=true]` (the CRD is large). Commit, push with the server token, hard-refresh `business-applications`, then:

Run: `ssh vishal@100.89.163.21 'kubectl -n agent-sandbox-system rollout status deploy/agent-sandbox-controller --timeout=180s && kubectl get crd sandboxes.agents.x-k8s.io'`
Expected: rollout successful; CRD present.

- [ ] **Step 2: Sandbox namespace with isolation**

`components/trueforge-sandboxes/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: trueforge-sandboxes
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.30
```

`networkpolicy.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-isolation
  namespace: trueforge-sandboxes
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: trueforge
          podSelector:
            matchLabels:
              app: trueforge
      ports:
        - protocol: TCP
          port: 4444
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 100.64.0.0/10
              - 169.254.0.0/16
```

`quota.yaml`:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: sandbox-quota
  namespace: trueforge-sandboxes
spec:
  hard:
    pods: "20"
    requests.cpu: "6"
    requests.memory: 12Gi
    limits.cpu: "24"
    limits.memory: 48Gi
    limits.ephemeral-storage: 120Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: sandbox-defaults
  namespace: trueforge-sandboxes
spec:
  limits:
    - type: Container
      default: { cpu: "2", memory: 4Gi, ephemeral-storage: 10Gi }
      defaultRequest: { cpu: 250m, memory: 512Mi }
```

`rbac.yaml`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: trueforge-sandbox-manager
  namespace: trueforge-sandboxes
rules:
  - apiGroups: ["agents.x-k8s.io"]
    resources: ["sandboxes"]
    verbs: ["create", "get", "list", "watch", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create", "get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: trueforge-sandbox-manager
  namespace: trueforge-sandboxes
subjects:
  - kind: ServiceAccount
    name: trueforge
    namespace: trueforge
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: trueforge-sandbox-manager
```

`ghcr-pull-secret.yaml`: same template as the host-app skill (`name: ghcr-pull`, namespace `trueforge-sandboxes`, token from `/home/vishal/.githubtoken`), and patch the namespace's default ServiceAccount to use it by adding to the kustomization:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - namespace.yaml
  - networkpolicy.yaml
  - quota.yaml
  - rbac.yaml
  - ghcr-pull-secret.yaml
patches:
  - target: { kind: ServiceAccount, name: default }
    patch: |-
      - op: add
        path: /imagePullSecrets
        value: [{ name: ghcr-pull }]
```

Kustomize cannot patch a ServiceAccount it does not declare, so also add `serviceaccount-default.yaml` (`apiVersion: v1, kind: ServiceAccount, metadata: {name: default, namespace: trueforge-sandboxes}, imagePullSecrets: [{name: ghcr-pull}]`) to `resources` and drop the `patches` block.

Validate: `ssh vishal@100.89.163.21 'cd /home/vishal/argocd-apps && kubectl kustomize components/trueforge-sandboxes >/dev/null && echo ok'` → `ok`. Add the ArgoCD Application `trueforge-sandboxes`, commit, push, refresh.

- [ ] **Step 3: Verify the restricted Pod Security level accepts the manifest**

```bash
ssh vishal@100.89.163.21 'cat <<EOF | kubectl apply --dry-run=server -f -
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata: { name: tf-psa-check, namespace: trueforge-sandboxes }
spec:
  shutdownPolicy: Delete
  podTemplate:
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: sandbox
          image: ghcr.io/vishal-pandey/trueforge-sandbox:latest
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
EOF'
```
Expected: `sandbox.agents.x-k8s.io/tf-psa-check created (server dry run)`. (PSA is enforced on the pod the controller creates; Step 6 confirms the real pod is admitted.)

- [ ] **Step 4: Point TrueForge at the fork image and enable the provider**

First `git pull --ff-only` on the server: `components/trueforge/` was changed separately to make `https://trueforge.itl.it.com` the primary host (`PUBLIC_BASE_URL`, ingress, Keycloak redirect URIs). Keep those values; only add what is listed below. In Steps 5–6 use `https://trueforge.itl.it.com`.

In `components/trueforge/`:
- `serviceaccount.yaml`: `ServiceAccount` `trueforge` in namespace `trueforge`, `automountServiceAccountToken: true`.
- `ghcr-pull-secret.yaml`: host-app template for namespace `trueforge`.
- `deployment.yaml` and `controller.yaml`: set `serviceAccountName: trueforge`, `imagePullSecrets: [{name: ghcr-pull}]`, `image: ghcr.io/vishal-pandey/trueforge:<vX.Y.Z from Task 6>`, `imagePullPolicy: IfNotPresent`. The from-source image's workdir is `/app/packages/trueforge`, so change the controller command to `["node", "dist/controller-main.js"]`.
- Add to the **server** container env only:

```yaml
        - name: KUBERNETES_SANDBOX_ENABLED
          value: "true"
        - name: KUBERNETES_SANDBOX_NAMESPACE
          value: "trueforge-sandboxes"
        - name: KUBERNETES_SANDBOX_IMAGE
          value: "ghcr.io/vishal-pandey/trueforge-sandbox:sha-<commit from Task 6 Step 4>"
        - name: KUBERNETES_SANDBOX_IDLE_TTL_MINUTES
          value: "60"
```

- `kustomization.yaml`: add `serviceaccount.yaml` and `ghcr-pull-secret.yaml`.

Validate with `kubectl kustomize`, commit (`trueforge: fork image + kubernetes sandbox provider`), push, hard-refresh `trueforge`.

Run: `ssh vishal@100.89.163.21 'kubectl -n trueforge rollout status deploy/trueforge --timeout=300s && kubectl -n trueforge rollout status deploy/trueforge-controller --timeout=300s && kubectl -n trueforge logs deploy/trueforge --tail=30 | grep -iE "listening|error"'`
Expected: both rollouts complete; log shows `Agent server listening`, no errors.

- [ ] **Step 5: Settings page shows the managed provider**

Open https://trueforge.codeshare.co.in/settings → Sandbox providers (use the `/browse` skill, signed in via SSO).
Expected: one configured row "Kubernetes (homelab)", status "Connected", label "Managed by server", no Configure/Update buttons; no "Available" Daytona row.

- [ ] **Step 6: End-to-end agent run**

In the UI, create an agent with the sandbox enabled and a model configured, start a chat, and send:
`Run python3 -c "import sys; print(sys.version)" in the sandbox, write /opt/tf/uploads/hello.txt containing "hi", then show me the file.`

Expected: the agent's exec tool call succeeds with a Python 3.13 version; the file is created; downloading it from the chat returns "hi". Then:

Run: `ssh vishal@100.89.163.21 'kubectl -n trueforge-sandboxes get sandboxes,pods -o wide'`
Expected: one `tf-<uuid>` Sandbox `Ready=True` and its pod `Running`, labelled `trueforge.dev/tenant`.

- [ ] **Step 7: Code Mode over the pod network**

Attach any connected MCP server/connector to the agent and ask it to call one of that server's tools from code in the sandbox (Code Mode). Expected: the tool result comes back; server logs show no `CodeModeNatsTransport` connection errors (`kubectl -n trueforge logs deploy/trueforge | grep -i nats`).

- [ ] **Step 8: Isolation checks (from inside the sandbox pod)**

```bash
ssh vishal@100.89.163.21 'P=$(kubectl -n trueforge-sandboxes get pods -o name | head -1); \
  kubectl -n trueforge-sandboxes exec $P -c sandbox -- sh -c "\
    id -u; \
    curl -s -o /dev/null -w \"internet:%{http_code}\n\" --max-time 8 https://pypi.org/simple/ ; \
    curl -s -o /dev/null -w \"k8s-api:%{http_code}\n\" --max-time 5 -k https://10.96.0.1/ || echo k8s-api:blocked; \
    python3 -c \"import socket; s=socket.socket(); s.settimeout(5); print(\\\"pg-ha:\\\", s.connect_ex((\\\"pg-ha-rw.postgres.svc.cluster.local\\\", 5432)))\" ; \
    curl -s -o /dev/null --max-time 5 http://192.168.1.9:22 && echo lan:open || echo lan:blocked; \
    ls /var/run/secrets/kubernetes.io 2>/dev/null || echo sa-token:absent"'
```
Expected: `1000`, `internet:200`, `k8s-api:blocked`, `pg-ha:` followed by a non-zero errno (timeout), `lan:blocked`, `sa-token:absent`.

- [ ] **Step 9: Idle cleanup and transparent recreate**

Temporarily set `KUBERNETES_SANDBOX_IDLE_TTL_MINUTES` to `2`, sync, send one message that uses the sandbox, wait 4 minutes, confirm `kubectl -n trueforge-sandboxes get sandboxes` shows it gone, then send another message in the **same chat** that uses the sandbox.
Expected: the Sandbox is deleted after ~2 idle minutes; the next message succeeds on a new `tf-<uuid>` sandbox (TrueForge recreated it). Restore the TTL to `60` and sync.

- [ ] **Step 10: Record the change**

Update `components/trueforge/README.md` on the server with: fork repo + image, sandbox provider env, `trueforge-sandboxes` isolation summary, and the gVisor switch (`KUBERNETES_SANDBOX_RUNTIME_CLASS=gvisor` once runsc is installed on all nodes). Commit and push.

---

## Upgrading from upstream (operational note)

```bash
cd ~/Business/trueforge && git fetch upstream --tags
git rebase '@truefoundry/trueforge@<new version>'
pnpm install --frozen-lockfile && pnpm --filter @truefoundry/trueforge-core test && pnpm --filter @truefoundry/trueforge test && pnpm --filter @truefoundry/trueforge-ui test
git push --force-with-lease origin main   # CI publishes a new server image; bump components/trueforge image tag
```

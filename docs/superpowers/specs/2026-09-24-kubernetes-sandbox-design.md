# Kubernetes sandbox provider (homelab fork) — design

**Date:** 2026-09-24 · **Status:** approved (user chose: build it, hardened runc now, gVisor later)

## Problem

TrueForge ships two sandbox providers: Daytona (hosted cloud, or a self-host whose OSS repo
was abandoned in June 2026) and `truefoundry` (TrueFoundry's commercial platform). We want
agent sandboxes to run **on our own homelab Kubernetes cluster**. google/ax was evaluated
and rejected (task orchestrator, not an exec sandbox; needs Agent Substrate + gVisor + a
newer Kubernetes than the cluster's 1.30; pre-stable).

## Decision

Add a third provider type, `kubernetes`, to a fork (`vishal-pandey/trueforge`, based on the
`@truefoundry/trueforge@0.2.1` release tag). Each TrueForge sandbox is one
`agents.x-k8s.io/v1beta1` `Sandbox` object managed by the kubernetes-sigs
**agent-sandbox v1.0.3** controller, which creates one pod (same name as the Sandbox).

## Requirements

1. **Provider contract.** Implements `SandboxProvider` (trueforge-core) fully, including
   Code Mode: `createSandbox`, `exec`, `uploadFile`, `downloadFile`, `buildImage`,
   `getImageBuildStatus`, path getters, `createCodeModeTransport`.
2. **Same filesystem layout as Daytona.** `/opt/tf/{uploads,skills,tool-results,skill_downloader.py,.git-credentials}`,
   MCP client at `/opt/tf/mcp-client/mcp_client.py`, symlink `/opt/tf/bin/mcp-client`,
   default working dir `/home/trueforge`.
3. **Image.** Derived from the upstream release sandbox image (NATS WebSocket bridge on
   port 4444 via supervisord), rebuilt to run as **uid 1000, non-root**. Built by GitHub
   Actions, published to GHCR. Never built locally.
4. **Exec semantics.** `result` = stdout and stderr interleaved (`2>&1`); `exitCode` = the
   command's exit code; per-call timeout (default 60 s, overridable per call) enforced
   in-pod with `timeout`, exit code 124 on expiry; infra failures → `{ success: false }`.
5. **Lifecycle.** Sandboxes expire after **60 idle minutes** (`spec.shutdownTime`, pushed
   forward on activity, `shutdownPolicy: Delete`). An expired/missing sandbox makes the
   provider throw `SandboxNotAvailableError`, and TrueForge transparently recreates it.
6. **Isolation (hardened runc).** Dedicated namespace `trueforge-sandboxes`; pod runs
   non-root with no privilege escalation, all capabilities dropped, seccomp RuntimeDefault,
   no service-account token; CPU/memory/ephemeral-storage limits; `NetworkPolicy`:
   ingress only from TrueForge server pods on 4444, egress to internet + DNS but **not**
   to cluster pod/service CIDRs, node IPs, or 192.168.1.0/24. `ResourceQuota` caps the
   namespace. `runtimeClassName` is a config knob so gVisor is a one-line switch later.
7. **Configuration.** Server-managed via env (`KUBERNETES_SANDBOX_*`), not the settings
   UI form. The Settings → Sandbox providers page shows a read-only
   "Kubernetes (homelab) · Connected" row with no Configure/Update actions.
8. **Least privilege.** TrueForge's ServiceAccount gets a namespaced Role in
   `trueforge-sandboxes` only: sandboxes (create/get/patch/delete/list), pods (get),
   pods/exec (create).
9. **Tenant scoping.** Sandbox ids are `<tenant>.<k8s-name>`; ownership is validated with
   the existing `validateSandboxOwnedByTenant`; pods are labelled with the tenant.

## Non-goals (v1)

Persistent volumes / suspend-resume, warm pools, gVisor, GPU, per-agent images, settings
UI form for the provider, upstreaming.

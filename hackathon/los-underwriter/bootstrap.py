"""Register the LOS agent layer in TrueForge (idempotent).

    uv run --with httpx agents/bootstrap.py --dry-run
    uv run --with httpx agents/bootstrap.py --local --model openai/gpt-5   # laptop: standalone TrueForge on :8790
    TRUEFORGE_TOKEN=... LOS_MCP_AGENT_KEY=... uv run --with httpx agents/bootstrap.py --model anthropic/claude-sonnet-4-6

What it does, in order (endpoints from the TrueForge source, packages/trueforge/src):
  1. MCP server `los`   GET/PUT /api/v1/settings/mcp-servers[/{name}]   (admin; PUT = create-or-replace by name)
  2. Skill (optional)   PUT     /api/v1/settings/skills                   (admin; git-backed, public GitHub/GitLab only)
  3. Agent              GET     /api/v1/agents?agent_name=...  then  PUT /api/v1/agents/{id}  or  POST /api/v1/agents
  4. Smoke check        GET     /api/v1/mcp-servers/los/tools             (TrueForge -> LOS tools/list)

--local targets a standalone TrueForge (`npx @truefoundry/trueforge`): base URL http://localhost:8790, the standalone
service key, LOS MCP at http://localhost:8000/mcp/, and no caller-identity forwarding (a fork-only feature; the LOS runs
with LOS_HITL_MODE=local instead).

Auth: `Authorization: Bearer $TRUEFORGE_TOKEN` — a JWT from Keycloak realm `homelab` with aud=trueforge whose
`groups` claim contains `trueforge-admin` (settings routes are admin-only). See agents/README.md.
Agents are "manage"-able only by their creator, so always run this as the same person.

Skill modes:
  --skill-git-url https://github.com/<org>/<repo>  → registers the git skill (path agents/skills/credit-policy) and
      enables the agent sandbox (TrueForge requires a sandbox provider for skills; the repo must be public — the
      sandbox's skill_downloader clones without credentials).
  (default) inline → the SKILL.md body is appended to the agent instructions; no sandbox needed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import secrets
import sys
from pathlib import Path
from typing import Any

try:
    import httpx
except ImportError:  # --generate-mcp-key needs only the standard library
    httpx = None  # type: ignore[assignment]

HERE = Path(__file__).resolve().parent
REDACTED = "***REDACTED***"  # packages/trueforge/src/utils/secretRedaction.ts — PUT keeps the stored header value
MCP_NAME = "los"
SKILL_NAME = "credit-policy"
SKILL_DIR = HERE / "skills" / SKILL_NAME
AGENT_DIRS = [HERE / "underwriter"]


def log(msg: str) -> None:
    print(msg, flush=True)


def redact(obj: Any) -> Any:
    s = json.dumps(obj)
    s = re.sub(r'"Bearer [^"]+"', '"Bearer ***"', s)
    return json.loads(s)


def split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, m.group(2)


class TrueForge:
    def __init__(self, base_url: str, token: str | None, dry_run: bool):
        self.dry_run = dry_run
        self.http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"} if token else {},
            timeout=httpx.Timeout(30.0, connect=10.0),
        )
        self.can_read = bool(token)

    def get(self, path: str, **params: Any) -> httpx.Response | None:
        if not self.can_read:
            return None
        return self.http.get(path, params=params or None)

    def write(self, method: str, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        if self.dry_run:
            log(f"  [dry-run] {method} {path}\n{json.dumps(redact(body), indent=2)[:4000]}")
            return None
        r = self.http.request(method, path, json=body)
        if r.status_code >= 400:
            raise SystemExit(f"  ✗ {method} {path} → {r.status_code}: {r.text[:1000]}")
        log(f"  ✓ {method} {path} → {r.status_code}")
        return r.json()


def ensure_mcp_server(tf: TrueForge, url: str, key: str | None, local: bool = False) -> None:
    log(f"MCP server '{MCP_NAME}' → {url}")
    tpl = json.loads((HERE / "mcp-servers" / f"{MCP_NAME}.json").read_text())
    body = copy.deepcopy(tpl)
    body["manifest"]["url"] = url
    if local:
        body["manifest"].pop("forward_caller_identity", None)
    existing = tf.get(f"/api/v1/settings/mcp-servers/{MCP_NAME}")
    exists = existing is not None and existing.status_code == 200
    if existing is not None and existing.status_code not in (200, 404):
        raise SystemExit(f"  ✗ GET mcp server → {existing.status_code}: {existing.text[:500]}")
    if key:
        secret = key
    elif exists or tf.dry_run:
        secret = None  # keep the stored secret
        log("  (no LOS_MCP_AGENT_KEY given — keeping the stored Authorization header)")
    else:
        raise SystemExit("  ✗ MCP server does not exist yet: set LOS_MCP_AGENT_KEY (see --generate-mcp-key)")
    body["manifest"]["auth"]["headers"]["Authorization"] = f"Bearer {secret}" if secret else REDACTED
    log(f"  {'update' if exists else 'create' if existing is not None else 'upsert'}")
    tf.write("PUT", "/api/v1/settings/mcp-servers", body)


def ensure_skill(tf: TrueForge, git_url: str, ref: str, path: str) -> None:
    meta, _ = split_frontmatter((SKILL_DIR / "SKILL.md").read_text())
    body = {"manifest": {"type": "git", "name": SKILL_NAME, "url": git_url, "path": path, "ref": ref,
                         "description": meta.get("description", "Credit analyst playbook")}}
    log(f"Skill '{SKILL_NAME}' → {git_url} @ {ref} : {path}")
    tf.write("PUT", "/api/v1/settings/skills", body)


def resolve_model(tf: TrueForge, model: str | None) -> str:
    if model:
        return model
    r = tf.get("/api/v1/models")
    if r is None or r.status_code != 200:
        if tf.dry_run:
            return "<provider/model>"
        raise SystemExit("--model is required (could not list models)")
    names = [m["name"] for m in r.json().get("data", [])]
    if len(names) == 1:
        log(f"Model: using the only configured model {names[0]}")
        return names[0]
    raise SystemExit(f"--model is required; configured models: {names}")


def build_agent(agent_dir: Path, model: str, skill_mode: str) -> dict[str, Any]:
    spec = json.loads((agent_dir / "agent.json").read_text())
    m = spec["manifest"]
    m["model"]["name"] = model
    instructions = (agent_dir / "instructions.md").read_text()
    if skill_mode == "git":
        m["skills"] = [{"name": SKILL_NAME, "preload": False}]
        m["config"]["sandbox"] = {"enabled": True, "file_downloads": False}
        m["config"]["context_management"]["large_tool_response"] = {"enabled": True}
    else:
        _, skill_body = split_frontmatter((SKILL_DIR / "SKILL.md").read_text())
        instructions += "\n\n---\n\n# Reference playbook (credit-policy skill, inlined)\n\n" + skill_body
        m["skills"] = []
    m["instructions"] = instructions
    return spec


def ensure_agent(tf: TrueForge, spec: dict[str, Any]) -> None:
    name = spec["name"]
    log(f"Agent '{name}' (model {spec['manifest']['model']['name']}, "
        f"instructions {len(spec['manifest']['instructions'])} chars)")
    r = tf.get("/api/v1/agents", agent_name=name, limit=100)
    agent_id = None
    if r is not None:
        if r.status_code != 200:
            raise SystemExit(f"  ✗ GET /api/v1/agents → {r.status_code}: {r.text[:500]}")
        agent_id = next((a["id"] for a in r.json().get("data", []) if a["name"] == name), None)
    if agent_id:
        log(f"  update id={agent_id}")
        tf.write("PUT", f"/api/v1/agents/{agent_id}", {"description": spec["description"], "manifest": spec["manifest"]})
    else:
        log("  create")
        tf.write("POST", "/api/v1/agents", {"name": name, "description": spec["description"], "manifest": spec["manifest"]})


def smoke_check(tf: TrueForge, spec: dict[str, Any]) -> None:
    r = tf.get(f"/api/v1/mcp-servers/{MCP_NAME}/tools")
    if r is None or tf.dry_run:
        return
    if r.status_code != 200:
        log(f"  ! tools/list via TrueForge → {r.status_code}: {r.text[:300]}")
        return
    names = {t.get("name") for t in r.json().get("data", [])}
    wanted = set(spec["manifest"]["mcp_servers"][0]["enable_tools"])
    missing = wanted - names
    log(f"Smoke: TrueForge sees {len(names)} LOS tools" + (f"; MISSING {sorted(missing)}" if missing else " — all allowed tools present"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default=os.getenv("TRUEFORGE_BASE_URL", "https://trueforge.itl.it.com"))
    ap.add_argument("--los-mcp-url", default=os.getenv("LOS_MCP_URL", "http://los-api.los.svc.cluster.local/mcp/"),
                    help="LOS MCP endpoint as reachable from TrueForge (public: https://los.itl.it.com/mcp/)")
    ap.add_argument("--model", default=os.getenv("TRUEFORGE_MODEL"), help="provider/model FQN configured in TrueForge")
    ap.add_argument("--skill-git-url", default=os.getenv("LOS_SKILL_GIT_URL"),
                    help="public GitHub/GitLab URL of the los repo; omit to inline the skill into the instructions")
    ap.add_argument("--skill-ref", default=os.getenv("LOS_SKILL_GIT_REF", "main"), help="branch, tag or commit (pin in prod)")
    ap.add_argument("--skill-path", default="agents/skills/credit-policy")
    ap.add_argument("--local", action="store_true", help="standalone TrueForge on this machine (see module docstring)")
    ap.add_argument("--dry-run", action="store_true", help="print the requests; perform GETs only if a token is set")
    ap.add_argument("--generate-mcp-key", action="store_true", help="print a new LOS MCP agent key + LOS_MCP_AGENT_KEYS value, then exit")
    args = ap.parse_args()

    if args.generate_mcp_key:
        key = "losk_" + secrets.token_urlsafe(32)
        log(f"LOS_MCP_AGENT_KEY={key}")
        log(f"LOS_MCP_AGENT_KEYS='{json.dumps({'los-underwriter': hashlib.sha256(key.encode()).hexdigest()})}'")
        return

    if httpx is None:
        sys.exit("httpx is required: uv run --with httpx agents/bootstrap.py ...")
    if args.local:
        if args.base_url == ap.get_default("base_url"):
            args.base_url = "http://localhost:8790"
        if args.los_mcp_url == ap.get_default("los_mcp_url"):
            args.los_mcp_url = "http://localhost:8000/mcp/"
    token = os.getenv("TRUEFORGE_TOKEN") or ("trueforge-standalone" if args.local else None)
    if not token and not args.dry_run:
        sys.exit("TRUEFORGE_TOKEN is required (admin JWT, aud=trueforge)")
    tf = TrueForge(args.base_url, token, args.dry_run)
    log(f"TrueForge: {args.base_url}{'  (dry run)' if args.dry_run else ''}")

    ensure_mcp_server(tf, args.los_mcp_url, os.getenv("LOS_MCP_AGENT_KEY"), args.local)
    skill_mode = "git" if args.skill_git_url else "inline"
    if skill_mode == "git":
        ensure_skill(tf, args.skill_git_url, args.skill_ref, args.skill_path)
    else:
        log(f"Skill '{SKILL_NAME}': inlined into agent instructions (no --skill-git-url)")
    model = resolve_model(tf, args.model)
    for d in AGENT_DIRS:
        spec = build_agent(d, model, skill_mode)
        ensure_agent(tf, spec)
        smoke_check(tf, spec)
    log("Done.")


if __name__ == "__main__":
    main()

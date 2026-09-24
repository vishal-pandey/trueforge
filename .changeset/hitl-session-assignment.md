---
'@truefoundry/trueforge': minor
'@truefoundry/trueforge-core': minor
---

Human-in-the-loop sessions: `POST /api/v1/sessions/{session_id}/assign` transfers session ownership (admin or `OIDC_SESSION_ASSIGNER_ROLE_VALUE` role), admins can read any session and list all subjects with `all_subjects=true`, and remote MCP servers can opt in to `forward_caller_identity` to receive the caller's token and identity headers during turns.

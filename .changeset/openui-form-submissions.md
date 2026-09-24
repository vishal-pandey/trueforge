---
'@truefoundry/trueforge-ui': minor
'@truefoundry/trueforge-core': minor
---

Generative UI forms now submit: a Form button with `@ToAssistant` sends its message plus the form values as fenced JSON from the latest assistant message (read-only, historical, and streaming blocks stay inert; `@OpenUrl` opens http(s) links only). The OpenUI prompt documents Form, input, and Button signatures and the decision-form rule.

# LoanDesk Agent: micro-loan underwriting on TrueForge

**The problem.** India's 6.3 crore micro-enterprises rarely get ₹25k–₹5L loans, because underwriting one by hand (KYC and income documents, bank statements, bureau, policy, pricing, a memo) costs more than the loan earns.

**What the agent reaches.** A live loan origination system through 17 MCP tools: verifications, credit policy, bank transactions, pricing and APR, document analysis and cross-check, recommendation, decision and disbursal. It also reads the borrower's documents directly and runs Python in a sandbox.

**Where it stops.**

1. **Credit decision** (`record_credit_decision`): a credit officer, credit manager or head of credit approves the tool call in TrueForge. The loan system verifies their forwarded identity, their authority for the amount and deviations, and maker ≠ checker.
2. **Disbursal release** (`release_disbursal`): an operations user types the KFS number and, under four-eyes, can't be the credit approver. Money leaving is irreversible, so the workflow cannot pay without it.

**Architecture.** The borrower app feeds the loan system (FastAPI, Postgres, Temporal), which starts a TrueForge session with the documents attached. The lead agent reads and cross-checks them, then runs four parallel sub-agents (identity, cash flow, bureau, business). The cash-flow specialist writes Python in the sandbox and pulls transactions over MCP. The lead builds a Generative UI decision desk, then the session is assigned to an underwriter.

**How TrueForge was used.** Agent manifest and instructions, a remote MCP server with a tool allowlist and approval gates, sandbox with Code Mode, dynamic sub-agents, Generative UI and tracing. We extended the fork with session assignment, caller-identity forwarding to MCP, Generative UI form submit and a Kubernetes sandbox provider.

**Real versus mocked.** Real: the MCP server and loan system, policy engine, pricing, APR and KFS, database, workflow, identity, and the agent, sandbox and sub-agents. Mocked: KYC, bureau, e-sign, mandate and lender disbursal, as deterministic sandbox adapters. A Setu Account Aggregator adapter is built but disabled, because the provider's sandbox rejects test OTPs.

**Known limits.** Generative UI forms omit untouched prefilled values. Watching a running case live needs TrueForge admin. The loan-system repo is private. OTPs are shown on screen in test mode. Mock data drives some risk flags.

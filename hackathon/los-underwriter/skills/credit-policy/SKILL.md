---
name: credit-policy
description: Credit analyst playbook for unsecured micro-enterprise (kirana, trader, tailor, repair, food, services) business loans in India — reading bank statements and Account Aggregator data, bureau (CIBIL/CRIF) interpretation, household income and the RBI microfinance 50% cap, fair practices, and how to write the credit memo. Use whenever underwriting or reviewing an LOS application.
---

# Micro-enterprise cash-flow underwriting (India)

The deterministic credit policy (BRE, `run_policy_check`) decides _what the policy says_. Your job is to judge whether the numbers behind it are real, explain them, and find what the rules cannot see. Everything below is about evidence: every claim in a memo should point to a figure, a date, or a rule.

---

## 1. Reading the bank statement

### 1.1 Turnover is not income

Bank credits are **sales**, not profit. A kirana banking ₹3,00,000 a month on a 10% margin earns ~₹30,000. The BRE assumes **12% net margin** on business credits when there are no financials. Sanity-check that against the category:

| Category                                                               | Typical net margin on turnover | Notes                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| Kirana / general store, FMCG distributor                               | 6–12%                          | High turnover, thin margin; stock purchases dominate debits                                |
| Wholesale trader, grain/vegetable commission agent                     | 3–8%                           | Very high throughput; margin assumption matters most here — be conservative                |
| Mobile recharge / payments agent, fuel                                 | 1–4%                           | Turnover is almost pass-through; 12% overstates income badly — flag and reduce             |
| Medical store                                                          | 12–20%                         | Regulated MRP; steady                                                                      |
| Tailoring, beauty parlour, repair (mobile, cycle, electrical), cobbler | 30–60%                         | Service-heavy: low credits can still mean decent income, but mostly cash — verify in field |
| Food stall, tea shop, tiffin                                           | 20–35%                         | Daily cash; seasonal with weather                                                          |
| Small manufacturing (papad, agarbatti, handloom)                       | 15–25%                         | Raw-material cycles; lumpy credits from a few buyers                                       |
| Transport (auto, tempo owner-driver)                                   | 20–35% after fuel              | Watch fuel debits, vehicle-loan EMIs                                                       |

If the category margin is well below 12%, the BRE's FOIR headroom is optimistic — recommend a lower amount than eligible and say why. If above, do **not** raise the amount beyond eligibility; mention it as a mitigant.

### 1.2 Business credits vs noise

Exclude from "business credits" (the BRE already tries; verify with `get_bank_transactions`):

- self-transfers between own accounts, cash deposited back after withdrawal the same day,
- loan disbursals (large one-off credit from an NBFC/bank/fintech, often followed by EMI debits a month later),
- refunds/reversals, interest, family remittances (regular same-amount credits from one party, monthly).

### 1.3 Average bank balance (ABB)

ABB = mean of balances on the 5th, 10th, 15th, 20th, 25th and month-end. For micro-enterprises:

- ABB ≥ one instalment is comfortable; ABB below one weekly instalment means repayment depends on same-day sales — prefer **weekly/daily** collection aligned to the cash cycle.
- Balance near zero before every month-end with big credits right after = cash-flow stress or a pass-through account.

### 1.4 UPI vs cash

- **Many small UPI credits from many distinct payers** (₹20–₹2,000, dozens per day) is the most reliable retail signature and very hard to fake. High `distinct_credit_counterparties` + low `top_counterparty_share` = genuine retail.
- **Cash-heavy** (> 80% cash deposits) is normal for kirana/food/tailoring in smaller towns, but the bank data can't prove it's business income: request the field officer's stock and footfall observation as a condition; do not reject for cash alone.
- A sudden shift from cash to UPI in the last 2–3 months can be genuine (QR adoption) — check that monthly totals, not just mode, stayed consistent.

### 1.5 Seasonality vs window dressing

- **Genuine seasonality**: repeats a pattern (Diwali/Dussehra Oct–Nov, Eid, Pongal/Sankranti, wedding seasons Nov–Feb and Apr–Jun, school reopening Jun, harvest months in agri districts, monsoon dip for outdoor food/transport). Supplier debits rise _before_ the peak (stocking up), credits spread across many payers.
- **Window dressing**: credits jump in the **last 30 days before application** (`last_30d_credit_spike` > 2.5× is a policy DEVIATION), come from **few** counterparties, arrive in round amounts, and are not matched by higher supplier purchases. Often leave again within days.
- When the spike is explained by a real festival and looks like prior years' pattern (if months cover it), say so; otherwise base affordability on the **median** month excluding the spike and flag `WINDOW_DRESSING`.

### 1.6 Round-tripping

Credit from counterparty X followed within ~3 days by a debit of similar amount (±10%) back to X, or to a key that repeatedly credits you. Purpose: inflate turnover. Checks:

- `round_trip_share` > 15% is a DEVIATION. Pull `only="CREDITS", min_amount_inr=<large>` and `only="DEBITS"` for the same window and match amounts/keys/dates.
- Legitimate look-alikes: paying back a supplier on credit terms (debits go to a _supplier_ key, credits come from customers — different keys), chit-fund/committee contributions (regular fixed amount monthly), family pooling. Explain which it is.
- If confirmed, compute business credits **net of the round-tripped amounts** and flag `ROUND_TRIPPING_SUSPECTED` (HIGH if > 25% of credits).

### 1.7 EMI identification

EMI debits: same amount, same day-of-month (±2 days), NACH/ECS/"ACH D"/lender-named, often to NBFC/fintech keys; weekly fixed debits in round amounts to a single key are often **MFI/JLG collections** or daily-collection loans. Compare:

- bank EMIs vs `bureau_summary.total_monthly_obligations` vs household declared obligations. The BRE takes the **max**.
- An EMI in the bank that is **not** on the bureau = an informal or unreported loan (moneylender, chit, BNPL) → `UNDISCLOSED_EMI` flag and include it in obligations.
- An EMI that stopped recently: ask whether the loan closed (bureau shows closed) or the borrower stopped paying (bureau DPD).

### 1.8 Bounces

Inward bounces = cheque/NACH/ECS returns **against** the borrower (insufficient funds). Policy: > 2 in 6 months = DEVIATION, > 4 = FAIL.

- One bounce followed by same-week successful re-presentation is a timing issue. Repeated bounces at month-end = structural shortfall.
- Bounces on an EMI mandate are worse than on a supplier cheque — note which.
- Charges like "RTN CHG"/"ECS RTN" confirm bounces even if the bounce itself is not tagged.

### 1.9 Declared vs banked

`declared_monthly_sales` / banked business credits:

- ≤ 1.5× is normal (cash sales not banked).
- 1.5–3× plausible for cash-heavy categories — needs field verification.
- > 3× — the declaration is unreliable; base everything on banked figures and say so.

---

## 2. Bureau interpretation (CIBIL / CRIF High Mark / Experian / Equifax)

- **Score**: CIBIL 300–900; CRIF 300–900 (similar bands). Policy: ≥ 650 PASS, 600–649 DEVIATION, < 600 FAIL. `-1`/`0`/no score = **NTC** (new to credit) or insufficient history.
- **NTC is not bad credit.** Many micro-entrepreneurs have never borrowed formally. NTC cap is ₹1,00,000. Rely on banking behaviour and field verification; prefer shorter tenure and weekly repayment for first loans.
- **DPD strings**: month-wise days past due, most recent first, e.g. `000 000 030 000 XXX` (XXX = not reported, STD = standard, SMA/SUB/DBT/LSS = asset classification). Read _recency_ and _repetition_: a single 30 in month 11 after clean history is much weaker than 30s in 3 of the last 6 months. 90+ in 24m, write-off, or settlement = FAIL (settled means the lender took a haircut).
- **MFI lender count**: > 3 active microfinance lenders = FAIL (over-indebtedness; also an RBI/SRO red line in practice). 2–3 active MFI/JLG loans + new unsecured ask = check the 50% cap carefully.
- **Enquiry hunger**: > 5 unsecured enquiries in 3 months = DEVIATION. Many enquiries across fintechs/NBFCs in a few weeks = the borrower is shopping because they were declined or are in stress; ask what happened to those enquiries (new accounts opened? not visible yet on bureau = hidden obligations).
- **Gold loans** are secured and common for liquidity — not a negative on their own, but frequent renewals/top-ups signal stress.
- **Credit cards**: high utilisation (> 80%) plus minimum-due payments = stress.
- Joint/guarantor accounts count toward obligations when the borrower is liable.

---

## 3. Household income and the RBI microfinance rules

RBI Master Direction — Regulatory Framework for Microfinance Loans (2022):

- A **collateral-free loan to a borrower whose household annual income ≤ ₹3,00,000** is a **microfinance loan**, whatever the purpose. The business loan becomes a microfinance loan for this borrower.
- **Household** = the individual, spouse and unmarried children (the RBI definition). Household income = all members' income from all sources (business net income, wages, pensions, rent, agri income, remittances).
- **Total monthly repayment obligations of the household on all loans (existing + proposed) must not exceed 50% of monthly household income.** This is a regulatory limit, not a deviation — nobody in the credit hierarchy can approve through it.
- Obligations include MFI/JLG, consumer durable, gold loan interest, informal loans visible in the bank, and the proposed instalment.

How to assess:

1. Take the household income from the application. If missing → the BRE returns `HOUSEHOLD_INCOME: MISSING` → you must REFER.
2. Cross-check: business net income from banking (§1.1) should not exceed the declared household income by much; if banking suggests income > ₹3L p.a. but the declaration says < ₹3L, the loan is still classified on the **assessed household income** — say which figure you trust and why. Under-declaring to fit into or out of microfinance are both red flags.
3. Obligations = max(declared, bureau, bank EMIs). Headroom = 50% × monthly household income − obligations. Recommended instalment converted to monthly (weekly × 52/12, fortnightly × 26/12, daily × working days) must be within headroom.
4. Not microfinance (income > ₹3L): FOIR cap (60% of estimated net business income less existing obligations) applies as policy.

---

## 4. Structuring the offer

- **Amount**: min(eligible amount, what the business actually needs for the stated purpose). Working-capital need ≈ 1–1.5 months of purchases for a trader. Asset purchase (sewing machine, fridge, tools) ≈ quotation.
- **Frequency**: match the cash cycle. Daily/weekly for kirana, food, repair; monthly for businesses paid monthly (contract tailoring, B2B suppliers). Weekly collection materially reduces risk for first-time borrowers.
- **Tenure**: 12–18 months for working capital; up to 24–36 only for assets with a life that long. Shorter tenure for NTC and deviation cases.
- **Rate**: default from policy; within the grid (22–30%). Price up within the grid for deviations or thin files; do not go outside the grid (that is itself a DEVIATION).
- **APR and KFS**: always quote APR from `compute_offer` (RBI KFS method, includes processing fee + GST). Digital Lending Directions: the borrower gets a KFS with APR before signing; disbursal goes only from the lender to the borrower's **verified** account (penny drop + name match) — make "verified disbursal account" a condition precedent if not already PASS.

Typical conditions precedent:

- Disbursal only to the penny-drop-verified account in the borrower's name.
- Field visit confirms stock/equipment and footfall consistent with banked sales (mandatory for cash-heavy or declared ≫ banked).
- NACH / UPI AutoPay mandate registered for the recommended frequency.
- Closure/NOC of a specific loan if its obligation was excluded.
- KFS explained in the borrower's language and acknowledged; cooling-off period disclosed.

---

## 5. Fair practices and conduct

- **Rejection reasons must be conveyed to the borrower** (Fair Practices Code). In a REJECT memo, map every reason to a plain-language reason the officer can pass on: credit history, business cash flows insufficient, existing obligations too high, unable to verify identity/business, business too new, outside product range.
- Never base a view on gender, religion, caste, community or marital status. Location matters only through business risk (e.g. flood-prone district seasonality), never as a proxy for community.
- No PII: work with masked data and pseudonymous counterparty keys. Never try to identify a counterparty.
- You do not communicate with the borrower; the human credit officer owns the decision and the communication.

---

## 6. Writing the credit memo

- Lead with the answer: decision, amount, tenure, frequency, instalment, APR, confidence.
- **Numbers, not adjectives**: "business credits ₹1,84,000/month avg over 6 months, CV 0.18, 72% UPI from 410 distinct payers" beats "healthy cash flow".
- Every DEVIATION: the rule, the value vs threshold, why acceptable (specific mitigant) or not, and the authority needed (deviations → credit_manager or above; amount bands per the delegation matrix).
- Every risk has a mitigant or is the reason for REFER/REJECT.
- State uncertainty explicitly: which figure you trust least, and what would change your view.
- Conditions go in both the memo and the `conditions` list.
- Keep it to what a credit officer needs to decide in ~5 minutes.

### Decision cheat-sheet

| Situation                                                                                                     | Recommendation                                                                          |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Any FAIL on proposed terms                                                                                    | REJECT (or REFER if the FAIL may be a data error, e.g. name match on a transliteration) |
| Any MISSING                                                                                                   | REFER — list what is missing and who supplies it                                        |
| ELIGIBLE, signals consistent                                                                                  | APPROVE at ≤ eligible amount                                                            |
| ELIGIBLE_WITH_DEVIATIONS, deviations explained by evidence                                                    | APPROVE with conditions; name each deviation and needed authority                       |
| Deviations unexplained, or banking contradicts declaration, or suspected round-tripping/window dressing > 25% | REFER with specific questions for field verification                                    |
| Microfinance and 50% cap leaves < ₹25,000                                                                     | REJECT (regulatory cap, not a deviation)                                                |

# Disclaimer

This project provides an **estimation and audit-trail tool** for the EU Carbon Border Adjustment
Mechanism (CBAM, Regulation (EU) 2023/956). Given a CN code, an origin country, and a tonnage, it
computes **embedded emissions**, the number of **CBAM certificates** owed, and their **cost** at
the EU ETS carbon price, using **published Commission default values**, and returns a per-line
audit trail of every lookup and factor used.

**It is not, and does not provide:**

- **Legal, tax, or customs advice.** Nothing here constitutes legal, regulatory, or compliance
  advice.
- **The official EU CBAM registry.** This is not an EU system and does not submit declarations. In
  v1 it produces a calculation and audit trail for the declarant's own use; registry submission is
  a documented, deferred follow-on.
- **A determination of eligibility.** It does not determine whether a party is an authorised CBAM
  declarant or otherwise eligible to import.
- **A verified-emissions service.** The calculation uses **default values**. Where the CBAM regime
  requires or permits **verified actual emissions**, those must be established by an **accredited
  verifier** — that is the declarant's obligation and is out of scope here.

**Two points that matter:**

1. **Default-value figures are estimates.** They are derived from Commission default embedded-
   emission values and country adjustment factors, not from installation-specific measured data.
   A `default-values` basis is stated on every calculation.
2. **The carbon price moves.** Certificate cost depends on the EU ETS price at the relevant time.
   The price and its `asOf` timestamp are recorded on every calculation; a stale cached price is
   flagged rather than served silently.

Calculated figures should be treated as decision-support estimates, not definitive legal or
financial determinations. Regulatory dates, thresholds, default values, and scope referenced in
this repository may change — always confirm against the current EU Official Journal texts, the
current Commission CBAM tables, and the current EU ETS price.

# Portfolio Evidence — Reference

This file is the single source of truth for every claim Jobe puts on a resume or in a cover letter. Anti-fabrication is enforced here: if it's not in this file, it doesn't go on the resume.

Organize by domain. The default scaffold below uses six domains (A1–A6) loosely mapped to Jobe's six archetypes (AI Platform / Agentic / Applied ML / Causal / ML Infrastructure / Forward Deployed). You can rename, add, or collapse them — the names matter only for your own organization.

For every project, document:

- **Project**: short identifier you'll recognize
- **Repo / artifact path**: where the code or evidence lives
- **What was built**: 1–2 sentences, function-described (no internal codenames)
- **Specifics**: algorithms, parameters, sample sizes, latency / throughput numbers, dataset shapes
- **Outcome**: business or research impact, ideally quantified
- **Failure modes addressed**: what could have gone wrong, what design choice prevented it

These specifics are what Jobe pulls into resume bullets via `data/bullet-library.json` and cover-letter reasoning. The deeper your reference, the more defensible the output.

---

## A1 — AI Platform / LLMOps

> *Example shape — replace with your own.*

**Project**: Embedding service
- **Repo**: `~/code/my-embedding-service`
- **What**: FastAPI service exposing `/v1/embeddings` with L2-normalized output.
- **Specifics**: nomic-embed-text-v1.5 model, batch size up to 256, sub-200ms p95 at 50 RPS on a single GPU.
- **Outcome**: reduced inference cost by replacing a third-party API at $X/M tokens.
- **Failure modes addressed**: API drift (decoupled the consumer from the upstream provider), latency spikes (warmed pool + batched inference).

---

## A2 — Agentic / Automation

*(Document your agent / orchestration / multi-step automation work here.)*

---

## A3 — Applied ML

*(Document your forecasting, ranking, recommendation, audience modeling work here.)*

---

## A4 — Causal / Experimentation

*(Document your A/B test, geo-experiment, synthetic control, propensity score, survival, lift-modeling work here.)*

---

## A5 — ML Infrastructure

*(Document your data pipeline, Spark / Airflow / Databricks, feature store, MLOps work here.)*

---

## A6 — Forward Deployed / Customer-Facing

*(Document your client-facing implementation, full-stack deployment, solutions architecture work here.)*

---

## Anti-Fabrication Rules

When Jobe drafts a resume or cover letter:

1. Every bullet must trace to a specific entry above. If it doesn't, the bullet doesn't ship.
2. Use the function description, not your internal codename. "Autonomous ML operations platform", not "OpenWidget".
3. If evidence is thin, the scorer returns *weak adjacency*, not *exact match*. Be honest in this file — Jobe's gate-pass logic depends on it.

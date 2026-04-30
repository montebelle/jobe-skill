# Shared Context

Loaded for every mode. Contains scoring, positioning, ATS rules, and anti-fabrication guardrails.

---

## Scoring Model

### Category Weights
| Category | Weight |
|---|---|
| Required Skills | 3x |
| Preferred Skills | 1x |
| Tech Stack | 2x |
| Domain Knowledge | 2x |
| Experience Level | 2x |
| Education | 1x |
| Soft / Cultural | 0.5x |

### Match Classifications
| Classification | Score | Definition |
|---|---|---|
| Exact Match | 1.0 | Done this exact thing with measurable proof. Cite repo path. |
| Strong Adjacency | 0.7 | Closely related, transferable. Explain connection. |
| Weak Adjacency | 0.4 | Some exposure, not at production scale. Be honest. |
| Gap | 0.0 | No evidence. Provide mitigation strategy. |

### Match Thresholds
| Threshold | Score | Strategy |
|---|---|---|
| Strong Match | 85-100% | Lead with confidence |
| Good Match | 70-84% | Lead with differentiators |
| Stretch Match | 55-69% | Lead with unique value |
| Reach | Below 55% | Recommend against unless extreme differentiators |

### Gate-Pass Rules
- **Gate 1**: Required Skills >= 50%
- **Gate 2**: Experience Level >= 0.7
If either fails, present breakdown and ask before generating resume.

---

## Archetype Detection

Classify every JD into one of 6 archetypes. The archetype drives which portfolio evidence to emphasize.

| Archetype | Detection Keywords | Portfolio Emphasis |
|---|---|---|
| AI Platform / LLMOps | LLM, platform, infrastructure, serving, inference, MLOps, model deployment | A1 (agents, embedding server), A5 (on-device inference), A9 (GCP pipelines) |
| Agentic / Automation | agent, automation, workflow, orchestration, tool calling, MCP, function calling | A1 (autonomous operations platform, safety enforcement, competitive intelligence system), A5 (on-device meeting assistant) |
| Applied ML | recommendation, ranking, search, ads, personalization, applied ML | A2 (forecasting), A10 (audience modeling), A11 (MMM, regression) |
| Causal / Experimentation | causal, experiment, A/B test, incrementality, measurement, attribution | A3 (survival, propensity), A4 (GeoLift, SDID), A8 (change point) |
| ML Infrastructure | pipeline, Airflow, Spark, data platform, feature store, batch, streaming, ETL | A2 (forecast orchestration), A9 (GCP BigQuery), A10 (Databricks/PySpark) |
| Forward Deployed | customer-facing, solutions, implementation, consulting, enterprise deployment | A1 (competitive intelligence skill), A12 (full-stack recommendation platform), prior agency client work |

---

## Positioning Reasoning (INTERNAL ONLY)

These are reasoning frameworks for deciding WHAT to include and HOW to frame it. They must NEVER appear as words in any resume, cover letter, or output the user sees. No "Talebian", no "barbell", no "antifragile", no "emergence", no "inversion". The user sees the result of this reasoning, not the reasoning itself.

However, the REASONING these frameworks produce MUST come through in the output -- especially cover letters. The reader should see cost-asymmetry thinking, tradeoff analysis, failure-mode reasoning, and inversion logic. They just should not see the labels. Example: don't write "I used a barbell approach." DO write "Cheap deterministic checks handle the bulk of violations at zero marginal cost; expensive LLM review is reserved for the edge cases that matter." The thinking is visible; the vocabulary is not.

**1. Fragility**: Claims backed by deep repos (3,000+ lines) are antifragile. Claims backed by a single notebook are fragile. Lead with antifragile. Never bluff.

**2. Antifragility**: Agent systems, on-device inference, causal inference, deep statistics gain value as the field shifts. Make them the resume's spine.

**3. Asymmetric Opportunities**: Include 1-2 projects the JD doesn't ask for but the team would value. Small risk (one wasted bullet), large upside (memorable candidate).

**4. Inversion**: What would make them NOT hire the candidate? Pre-empt each objection with a resume bullet. No MS/PhD -> lead with statistical sophistication. CPG company -> lead with infrastructure. Agency background -> emphasize in-house production.

**5. Barbell**: 70% safe (exact JD matches, boring and precise) + 30% bold (unique differentiators no other candidate has). Kill the generic middle.

**6. Emergence**: Career arc: front-end -> data science -> management -> ML engineering = builder who owns research to deployment to UI. Summary must capture this.

**Source Framework**: The six lenses above (fragility, antifragility, asymmetry, inversion, barbell, emergence) are drawn from Taleb's *Antifragile* and *Fooled by Randomness*, augmented with Kahneman's WYSIATI / System 1–2 bias-awareness. Use them to generate reasoning-rich output where the thinking is visible but the terminology is absent.

---

## ATS Format Rules

Evidence-weighted. Rules with empirical backing are cited; rules without rigorous sources are kept as directional priors and labeled accordingly.

1. **Single column** (supported: Enhancv 2024 template-testing found single-column parses more reliably than multi-column; directional, not peer-reviewed)
2. **No tables, graphics, text boxes, icons** (supported: multiple ATS vendor parsers degrade on non-text structural elements; exact failure rate is vendor-specific)
3. **Standard headers**: SUMMARY, EXPERIENCE, SKILLS, EDUCATION
4. **Calibri or Arial font** (no specific empirical backing; common convention)
5. **Two pages** (supported: ResumeGo 2018, n=482 recruiters, controlled simulation, 2.3x preference for 2-page over 1-page for mid/senior roles; industry survey, not peer-reviewed)
6. **475-600 words** (directional only; the specific "8.2% interview rate" number has been removed as unsourced)
7. **Quantified results on every bullet** (directional; XYZ formula is a teaching framework, not an RCT-validated tactic)
8. **70%+ JD keyword match** (directional; ATS keyword-matching is empirically how most ATS rank, but the "2.5x callbacks" number is unsourced. Tailoring per JD is supported by Resumly industry data and Resume2Vec MDPI 2024 (+15.85% nDCG), both of moderate strength)
9. **Bold job titles, bulleted accomplishments** (common convention; F-pattern reading is from Nielsen Norman eye-tracking, which studied web pages, not resumes)
10. **No em-dashes, en-dashes, smart quotes, or Unicode. Plain ASCII only.** (operational: ATS parsers have documented failures on Unicode; defensive)
11. **XYZ formula: "Accomplished X as measured by Y by doing Z"** (Google-origin teaching framework, no RCT validation, but aligns with quantification as a prior)

### What the empirical literature DOES strongly support (use these as priorities)

- **Referrals dominate cold apply** (Burks et al QJE 2015; Friebel et al NBER 2019). Effect size >>> any formatting change. See `/jobe contacto` mode.
- **Name-based discrimination in screening exists** (Bertrand & Mullainathan AER 2004, mixed replication). Implication: if the candidate's name or background invites bias, referrals matter even more.
- **LLM-based screening has measurable demographic variance** (Brookings 2024). Implication: don't assume a single model's score is neutral; run bias audits.

---

## Cover Letter Rules

- 250-350 words, 3 paragraphs, one page
- **P1 (Hook)**: Lead with YOUR achievement, not company flattery. Achievement first, company connection second, role name third.
- **P2 (Proof)**: 1-2 achievements mapped to top JD requirements. Go deep on one story. Specific technologies and metrics. XYZ formula.
- **P3 (Close)**: Value restatement + genuine enthusiasm for specific team/product + availability. Not "I look forward to hearing from you."
- No generic content. Every sentence specific to THIS company and THIS role.
- Plain ASCII. No em-dashes or special characters.

### Reasoning-First Cover Letters

The cover letter must demonstrate HOW the candidate thinks, not just WHAT was built. Every technical achievement mentioned should include the reasoning behind the design decision.

- BAD: "I built a 4-hook safety layer with regex + LLM review achieving zero incidents"
- GOOD: "The safety layer is barbelled: cheap deterministic regex catches 85% of violations at zero marginal cost, while expensive LLM review handles edge cases. A safety system too expensive to run on every output is a safety system that gets turned off."

The Positioning Reasoning lenses should come through as REASONING in the letter text. The vocabulary never appears, but the THINKING does. The reader should see cost/benefit tradeoffs, asymmetric reasoning, and inversion logic without ever seeing the labels.

For every technical claim in the cover letter, answer at least one of:
- Why was it designed this way instead of the obvious alternative?
- What tradeoff was being navigated?
- What failure mode was being prevented?
- What would have happened if this decision were wrong?

Reference: If you maintain your own reasoning-framework doc, load it here and use it to internalize the reasoning style when generating cover letters.

---

## Anti-Fabrication Rules

- Every claim must have code-level proof from the candidate's repos
- NEVER inflate scores. If evidence is thin, score as weak adjacency or gap.
- NEVER add skills the user doesn't have. Only reformulate real experience with JD vocabulary.
- Every exact match MUST cite a specific repo path
- No skills on resume that can't be defended in a technical interview
- No buzzwords: "results-driven", "passionate", "leveraged"

---

## Ghost Job Detection (Block G)

Multi-signal scoring via `lib/ghost-score.js`. Each signal returns a value in [0,1]; the final ghost score is the max of all signals (any one strong signal is enough to flag).

Signals:
1. **Age signal**: posting age vs threshold (30 days baseline; +15 days for senior/staff IC roles per Review of Accounting Studies 2023 on high-skill vacancy duration)
2. **Repost signal**: same requisition posted 3+ times
3. **Company ratio signal**: hires-per-posting ratio (Revelio Labs 2024 baseline ~0.5; <0.25 is strong ghost signal)
4. **Layoff signal**: company announced layoffs in last 30/90/180 days
5. **Title fuzz signal**: "talent network", "future openings", "general application" titles

Labels:
- **High Confidence** (score < 0.30): show normally
- **Proceed with Caution** (0.30 to 0.60): show with flag
- **Suspicious** (>= 0.60): hide by default, accessible with `--show-ghosts`

Empirical backing: Clarify Capital 2024 (n=1,200: 1-in-3 postings >30 days, 1-in-5 intentionally unfilled), Hunter Ng arXiv 2410.21771 (2024), Revelio Labs 2024. Government/academic roles have longer legitimate timelines (age signal alone should not gate them). Recruiter-sourced is a positive signal.

---

## Competitor Framework

| Tier | Examples | Typical Applicant |
|---|---|---|
| FAANG/Tier-1 | Google, Meta, Apple, Amazon, Netflix, OpenAI, Anthropic | Top-school MS/PhD, 5+ publications, FAANG pedigree |
| Strong Tech | Stripe, Databricks, Airbnb, Spotify, DoorDash, Scale AI | MS/PhD, 2-3 years at known company, strong coding + ML |
| Growth | Series B-D startups | Generalists, breadth, strong builders |
| Enterprise/CPG | Consumer goods, banking, agencies | Business-oriented ML, MBA+MS combos |
| Finance | Goldman, Citi, Capital One | Quant backgrounds, strong math |

### Your Rare Combinations (populate in `_profile.md`)
Document the combinations of skills in your own profile that are uncommon at the tiers you target. Jobe uses this list to decide which bullets to lead with in a tailored resume. Example categories:
1. ML Engineering + Full-Stack
2. Statistical Rigor + Production Engineering
3. On-Device / Edge Inference
4. Causal Inference at Scale
5. Cross-Domain Breadth
6. Applied Math Foundation

---

## Bullet Selection (REQUIRED for Resume Generation)

For every resume generated (single-posting via `/jobe [url]`, multi-posting via `/jobe batch`, or auto-evaluate from `/jobe find`), bullets MUST be selected from `data/bullet-library.json` via `lib/bullet-select.js`. Do not hand-author bullets and do not use the deprecated "fixed integer-permutation" pattern.

### Why
Reordering a fixed bullet pool produces resumes interchangeable in body content; only summary + cover letter end up unique. Per-JD bullet text variation requires a tagged library and per-spec selection.

### How

```js
const { buildExperience, pickProjects } = require('./lib/bullet-select');
const baseline = require('./data/resume-baseline.json');
const spec = {
  archetype: '<from Block A archetype detection>',
  jdText: '<raw JD text from posting>',
  // bulletCounts keys must match role-keys in your bullet-library.json
  bulletCounts: { current: 4, prior1: 2, prior2: 2, prior3: 1 },
  pinBullets: [],     // optional must-include bullet IDs
  excludeBullets: [], // optional skip IDs
};
resume.experience = buildExperience(baseline, spec);
resume.selectedProjects = pickProjects(spec, 2);
```

`buildExperience` walks each baseline experience entry, resolves `company` to a library role-key (via `library.companyKeyMap` declared in your `bullet-library.json`, optionally overridden by `spec.companyKeyMap`, with `companySlug(company)` fallback), filters that role's bullet pool by archetype, scores remaining by JD-keyword overlap, and returns the top N. `pickProjects` does the same against the library's `selectedProjects` array.

### Bullet library structure

Your `data/bullet-library.json` must have shape:

```json
{
  "companyKeyMap": {
    "Acme Corp": "current",
    "Previous Co": "prior1"
  },
  "current": [
    {
      "id": "current-causal-survival",
      "archetypes": ["Causal", "Applied ML"],
      "keywords": ["survival", "hazard ratio", "ROAS", "propensity"],
      "text": "Shipped a 33M-user discrete-time complementary log-log survival model..."
    }
  ],
  "prior1": [...],
  "selectedProjects": [...]
}
```

Each bullet should be pre-written at the depth you want it to appear in the resume. The selector picks; it does not paraphrase.

### Attribution Rules (Define in your own _profile.md and bullet library)

For every employer in your `data/resume-baseline.json` `experience[]`, the bullet library must contain only claims that trace to actual repos / artifacts under that employer. Do not let bullets from one role's repos surface under another role's section. The `companyKeyMap` is the gate — get it right and the selector will not mix attributions.

If you have a side-consultancy / parallel project that overlaps with your day job, declare each separately in the experience array AND keep the bullet pools strictly disjoint. The single biggest failure mode for tailored resumes is mis-attributing side-project work to the day job.

### Cover Letter Quality Bar

Every cover letter MUST contain at minimum:

1. **One specific dollar amount or measurable business outcome**: e.g., "$2M+ quarterly savings", "33M users", "MDE 7.5% at 80% power".
2. **One leadership / scope signal**: e.g., "led 8 reports across 5 clients", "founder of multi-client AI-automation consultancy", "lead the production ML stack across 4 divisions".
3. **One decision-grade outcome**: an outcome that materially changed how the business allocates resources, runs experiments, or makes a build/buy/scale decision.

If a cover letter draft fails any of these three checks, it is incomplete. Regenerate with explicit business-impact and leadership content from the bullet library.

### Selected Projects Rendering

`scripts/render-docx.js` `buildSelectedProjects(projects)` renders the Selected Projects section between Experience and Skills when `resume.selectedProjects` is a non-empty array. Old-format resume JSONs without `selectedProjects` field render unchanged (backwards-compatible).

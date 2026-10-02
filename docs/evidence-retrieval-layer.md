# Evidence retrieval layer (optional)

This layer is optional. It helps only when part of your evidence is plain text you keep on this machine: source code, notebooks, notes, markdown. A registered nurse or a tax accountant whose proof lives in charts, filings, or office documents has nothing for it to read and loses nothing by skipping it. With no evidence roots configured every command below exits cleanly and the rest of Jobe behaves exactly as it does without it.

## The problem it solves

A skill you have plainly used can still read as a gap in a tailoring brief, simply because no bullet and no skills entry names it. Evidence normally reaches a resume through two hand written files, `data/bullet-library.json` and `reference.md`. Whatever nobody wrote down there is invisible, and the fix used to depend on someone remembering to open the right folder.

The rule this layer enforces: **a tool that is provably present in your own work is never reported as a gap.**

## What it is

One script, `scripts/evidence-index.js`, that scans your work folders for your own vocabulary and writes a lookup file.

```bash
node scripts/evidence-index.js build [--roots a,b,c]   # scan and write data/evidence-index.json
node scripts/evidence-index.js has <tool>              # which projects have it (exit 1 if none)
node scripts/evidence-index.js tools                   # every tool found, with its project count
node scripts/evidence-index.js selftest                # the index file is well formed
```

### What it looks for

No tool table ships. The vocabulary is yours:

* every `keywords[]` entry in your `data/bullet-library.json`
* the `skills` block of your `data/resume-baseline.json`
* `evidence.tools[]` in your `data/profile.json`

An `evidence.tools` entry is a plain name, or an object for a tool whose presence is proven by something other than its name:

```json
{ "name": "<tool>", "match": ["<regular expression source>"], "aliases": ["<another spelling>"] }
```

`TOOL_ALIAS` in `lib/tailor.js` only folds spellings of the same thing into one key. It decides nothing about what is indexed.

### Where it looks

`--roots a,b,c` on the command line, when given, is the whole list. Otherwise the roots are the union of:

* `evidence.roots[]` in `data/profile.json`. Absolute paths; a leading `~` expands to your home folder.
* The `JOBE_EVIDENCE_ROOTS` environment variable, a path list in your system's own path separator.
* `<workspace>/data/.evidence-corpus/`, when it exists. This is a place to keep copies of work that lives only on a remote (clone them there yourself; `evidence.githubAccounts[]` is a note of which accounts to refresh from, account names only).

A project is a child folder of a root that holds `.git`, a nested one under a grouping folder, a plain child folder, or the root itself when it holds only files. Each project is walked five levels deep, files over 5 MB and vendored folders are skipped.

### What it writes

`<workspace>/data/evidence-index.json`:

```json
{
  "generatedFrom": ["<root>", "..."],
  "repoCount": 0,
  "toolPresence": { "<tool>": ["<project>", "..."] },
  "aliases": { "<other spelling>": "<tool>" },
  "repos": [{ "name": "", "path": "", "files": { ".py": 0 }, "tools": [], "readme": "" }]
}
```

The file holds absolute paths and README excerpts of your own folders. It is user data: it lives in your workspace, it is ignored by git, and it is never shipped.

## How the pipeline uses it

* `lib/tailor.js tailorBrief()` credits the index during gap detection. A top job description term that matches an indexed tool (directly or through an alias) is treated as covered, even when no bullet and no skills entry names it. The index is reread whenever the file changes.
* `lib/rank.js buildProfile()` treats every indexed tool as a held skill at the 0.6 level, the same level as a skill listed only in your resume skills block. A tool found there can never score as a declared gap.

That is all it does. It feeds discovery of evidence; it does not write resumes.

## What stays the same

* **Stated skills stay authoritative.** The index only credits evidence. It never strips or downgrades a skill you stated because no file mentions it. Much real work (outcomes at an employer, client engagements, anything under a confidentiality rule) is in no folder you can scan.
* **The render contract.** Resumes are still written from the job description, your evidence file, and your bullet library, then pass the same audits. A tool the index found still needs a bullet before it can be claimed in a resume body.
* **The coverage and depth gates.** `scripts/check-evidence-coverage.js` (every capability you listed in `data/evidence-anchors.json` has a library bullet) and `scripts/check-evidence-depth.js` (bullets about a major body of work name how it works, not only its size) are separate, also optional, and also exit 0 when their data files are absent or empty. A data file (or bullet library) that exists but is not valid JSON exits 2 with `cannot parse <file>`.

## Semantic search (optional, not included)

The index answers "do I have tool X". It does not answer "what have I built that resembles this responsibility". If you already use a local semantic code search tool, point it at the same roots and consult it while writing bullets. Jobe does not ship one, does not require one, and no mode fails without one. Prefer a tool that runs locally, so your source never leaves the machine.

## Refresh

Rebuild after your work folders change, or after you add keywords to the bullet library:

```bash
node scripts/evidence-index.js build
```

## Limits

* Plain text only. Office documents, PDFs, and spreadsheets are not read. Export them to text, or keep notes beside them, to have them indexed.
* Loose files directly under a root that also has subfolders are not read. Put them in a subfolder.
* A bare one or two letter Latin name (`go`, `r`) matches too much text to prove anything, so it is found only through a longer alias or an explicit `match` pattern. `build` lists such names on a `not searched` line.
* Terms match in any script. A term in a script written without spaces between words (Han, kana, Hangul, Thai, Lao, Khmer, Myanmar) is matched as a plain substring, and a single character term in those scripts is not searched.
* Presence is not proficiency. The index says a tool appears in a project. How well you know it is for you and your bullets to say.
* No roots, or no vocabulary yet: `build` prints why, writes nothing, and exits 0.

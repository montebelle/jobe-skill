# Known limitations

Every deliberate ceiling in Jobe, one line each: where it lives, what it does not do, and how to lift it. The first part is collected from the `ponytail:` comments in the code (`grep -rn 'ponytail:' lib collectors scripts install-local.sh`); a test fails when a file that carries such a comment is missing here. The second part lists limits that have no comment in the code: behavior that was measured and left as it is.

Nothing here loses data silently. Where a rule cannot decide, it errs toward keeping a posting, labeling a value as unknown, or leaving a question for you.

## Scoring (`lib/rank.js`)

| Where | Ceiling | Upgrade path |
|---|---|---|
| `lib/rank.js` fit constants | The coverage constants are tuned on synthetic postings from two professions and on one hand rated table. | Retune them together, against both, if the 80/65/55 bands drift. |
| `lib/rank.js` `WEAK_SHARE` | One calibration point: a hand rated table has about a fifth of its terms below 0.6. | Retune together with `FULL_TABLE`. |
| `lib/rank.js` `FIELD_FULL` | The field check is switched off by a title that shares a word with a target role, so a poor fit under a familiar title is scored by the rated skills it names alone. | Weigh rated hits by where in the posting they sit (duties and requirements, not boilerplate). |
| `lib/rank.js` `cleanTerm` | User words mirror the letter fold of stored posting text, not its symbol rewrites (a raw `<` stays a `<`). | One shared fold in `lib/normalize.js`. |
| `lib/rank.js` `termPattern`, `sameStem` | A suffix list, not a stemmer: irregular forms ("analysis" and "analyses", "analysis" and "analyze") do not match. | A real stemmer on both sides. |
| `lib/rank.js` `DEGREE_LEVELS` | An abbreviation list of mostly US and UK credentials; an unrecognized credential is unknown, which skips the degree checks. | An explicit level key in `candidate.degrees`. |
| `lib/rank.js` `MS_DEGREE` | A closed list of product names; "MS" before an unlisted product still reads as a degree. | Extend the list. |
| `lib/rank.js` derived estimate | It tracks field and breadth, not your own ranking of your skills. | Fill in `skills.levels` at onboarding, weak skills included. |
| `lib/rank.js` `vocabularyCoverage` | Single words only: no synonyms ("intravenous" does not find "IV") and no phrases. | Phrase evidence from the bullet keywords. |
| `lib/rank.js` aside detection | The form of a line is read from its first words and a few cue words, so an aside with no heading of its own still counts as unmet demand. | A sentence classifier (duty, ask, statement). |
| `lib/rank.js` differentiator count | Several spellings of one skill each count, so the count is dampened (one term 1.2, four 3.4, eight 5.7) instead of grouped. | A group key in `skills.levels`, 1.2 per group. |

## Policy, postings, dedup

| Where | Ceiling | Upgrade path |
|---|---|---|
| `lib/profile.js` `REGIONS` | Region codes are known for four countries (US, Canada, Australia, UK). Elsewhere a region matches by name only, so list both the name and the code. A code shared by two regions stands for both. | ISO 3166-2 data. |
| `lib/profile.js` `countryOk` | A naive country model: two letter codes collide with US state codes and short words, which errs toward keeping; a city alone in another country is kept as unknown unless it is one of a few dozen known cities. | A country and region classifier. |
| `lib/profile.js` `regionOk` | A whole phrase match with no distance model; a name that is both a city and a region keeps the whole region; with no country named a region code is trusted. | A gazetteer with distances. |
| `lib/posting.js` `cleanAscii` | A title, company or location written in a non Latin script folds to empty, so the row is discarded (no title) or kept with no location. | Fold for the keys only and keep the display text. |
| `lib/posting.js` `HOME_WORDS` | Remote wording is English only (remote, home based, homeworking, work from home, telework). | A table of wordings per language. |
| `lib/enrich.js` pay parser | Yearly ranges in eight currency codes (USD, GBP, EUR, CAD, AUD, NZD, SGD, CHF) and the dollar, pound and euro signs. Anything else is unknown, which the pay floor keeps. | A currency and pay period field filled by the sources. |
| `collectors/pipeline.js` `publishedMax` | A band under 1000 is read as hourly or monthly, and a band with a stated non yearly period is not annualized. Both are unknown, which is kept. | A pay period and currency field on `Posting.compensation`. |
| `lib/role-queries.js` `tokensMatch` | A prefix heuristic, not a stemmer; it joins a few unrelated words that share a long prefix. | A real stemmer if that noise shows up in results. |
| `lib/dedup.js` `place` | US and country unknown share the place "remote"; two wordings of one other remote place ("Remote, Canada", "Remote (CAN)") stay two rows. | Canonical place names per country. |
| `lib/dedup.js` `reportSlug` | Keyed on the policy passed in: a run that lifts a remote only profile with a flag builds city free slugs unless the caller passes its merged filters. | Pass the merged filters (the modes do). |
| `lib/dedup.js` `reportSlug` | A mixed script title stored by the pipeline is already folded, so its batch slug has no hash while the same title read off the page gets one. | Keep the display title on the posting (see `lib/posting.js` above). |
| `lib/slug-harvest.js` | Three of the harvested board patterns are read by no crawler yet. | Drop them from the harvest or teach the crawlers to read the index. |
| `lib/slug-harvest.js` `searchCountry` | The search API accepts a fixed list of markets; a rejected query is logged and skipped. | Validate against that list. |

## Tailoring and render gates

| Where | Ceiling | Upgrade path |
|---|---|---|
| `lib/tailor.js` `tokenize` | No JD keywords for scripts written without spaces, so the coverage gates stay passive there. | Split the runs with a word segmenter and add a stop list per language. |
| `lib/tailor.js` `STOPWORDS` | English only: a posting in another language ranks its own function words, and generic JD words are not filtered beyond English function words. | A stop list per language. |
| `lib/tailor.js` section headings | A short list item with no full stop that contains a heading word still reads as a heading. | A profile supplied heading list. |
| `lib/tailor.js` trailing sections | A trailing unlisted section that has bullets of its own (a perks list) is still counted. | Add its heading to the stop list. |
| `lib/tailor.js` employer name | A one word employer name that is also a field word is dropped where the JD capitalizes it and counted where it is lowercase. | Pass the full employer name. |
| `lib/tailor.js` `whyHasAnchor` | A capitalized word in mid sentence reads as a proper noun, so the candidate's own title or a month name also passes; only the words of the name as given are set aside. | Store the full employer name in `resume.company`; tighten if filler gets through. |
| `lib/tailor.js` `whyHasAnchor` | Scripts without letter case need a figure or a quoted phrase as the anchor; German capitalizes every noun, so the check is effectively off there. | A per language signal. |
| `lib/tailor.js` `CL_OUTCOME_RE` | A four digit count starting 19 or 20 reads as a year; the plural test is a suffix check. | Write the figure with a separator; add irregular plurals to the list. |
| `lib/tailor.js` `auditCoverLetter` | A letter not written in English is checked only for a figure, a length of at least 100 words, and that the employer is named; leadership and decision signals are not checked. | Per language word lists, or a language key in the profile. |
| `lib/tailor.js` `auditCoverLetter` | In that lighter bar a two digit duration, a clock time, or a five digit postal code still counts as the figure. | A per language unit list. |
| `scripts/render-cover-letter.js` | English is told apart by a greeting or sign off, else by the share of a few function words (30 words or more), else by the absence of non ASCII letters. | A language key in the profile. |
| `scripts/evidence-index.js` | Plain text files only: office documents, PDFs and spreadsheets are not read. | Export them to text, or keep notes beside them. |
| `scripts/evidence-index.js` | A term in a script written without spaces is matched as a plain substring; a bare one or two letter word is found only through a longer alias or an explicit pattern. | A word segmenter; an `evidence.tools` match pattern. |

## Sources

| Where | Ceiling | Upgrade path |
|---|---|---|
| `collectors/sources/aggregators/linkedin-guest.js` | An onsite or hybrid search covers the first two seed places of a role, and requests scale with the number of accepted work modes. | A page cap per place and per type. |
| `collectors/sources/aggregators/linkedin-guest.js` | No gazetteer: a trailing city in a title that is neither on the card nor followed by a region is missed, which leaves a provisional remote label for `verify-remote.js` to correct. | A city list per country. |
| `collectors/sources/aggregators/linkedin-guest.js` | The country is sent as free text and only when the list resolves to one country. | LinkedIn geo ids, one search per listed country. |
| `collectors/sources/aggregators/adzuna.js` | The API needs exactly one market: the first country in your list. | One request per listed country. |
| `collectors/sources/aggregators/jooble.js` | A role seeded in several locations is searched in the first one only, to protect the lifetime quota. | One request per seed pair. |
| `collectors/sources/aggregators/jobicy.js` | Only the United States maps to a region filter; any other country policy queries every region. | A country to region table. |
| `collectors/sources/aggregators/themuse.js` | A fixed depth of five pages for the feed with no category. | Set `THEMUSE_CATEGORIES`; raise the depth. |
| `collectors/sources/aggregators/hiring-cafe.js` | The build id is scraped per run (a deploy in the middle of a run returns nothing), and only the United States has a location scope. | Build the location object from `discovery.countries` once the shape is confirmed. |
| `collectors/sources/aggregators/serpapi-site-search.js` | The employer name is the first host label that is not a careers prefix, which is wrong for an employer hosted under a department label. | Pass `{ site, company }` in `discovery.companySites`. |
| `collectors/sources/ats-direct/breezy.js`, `collectors/sources/ats-direct/workable.js` | Fixed pacing between requests (300 ms and 500 ms). | Tune when a large tenant list makes runs slow or 429s appear. |
| `collectors/enrich-run.js` | Unbounded fan out, fine at the default `--top 60`. | Bound it the way the pipeline's `mapLimit` does. |
| `lib/linkedin.js` `buildSearchUrl` | Only the United States has a geo id, and the signed in sweep takes no place for onsite work. | A geo id per country, or the `location` text parameter. |
| `lib/linkedin.js` `parseSearchCards` | English workplace tags and a comma shape; a bare country name with no tag is missed. | Take the node that follows the company. |

## Resolve, verify, present

| Where | Ceiling | Upgrade path |
|---|---|---|
| `scripts/verify-listing.js` | With no pipeline label, a bare "hybrid" word decides; it errs toward not calling a role remote. | Phrase level patterns only. |
| `scripts/verify-remote.js` | With no workplace field on the page, a bare "hybrid" anywhere in its text means hybrid ("hybrid cloud" too). Unverified is never remote. | Phrase level patterns. |
| `scripts/final-list.js` | A fixed list of large US cities: a smaller town with no state stays "country unverified". | The country and region classifier. |
| `scripts/resolve-linkedin-to-ats.js` | After a link is rewritten the same requisition may already be in the list from an ATS source; the duplicate is visible, not merged. | Rerun `lib/dedup` over the list after `--write`. |
| `scripts/linkedin-guest-sweep.js` | The guest search takes one location, so a list naming several countries searches without one. | One pass per country. |

## Apply harness

| Where | Ceiling | Upgrade path |
|---|---|---|
| `lib/apply/answers.js` live pay band | Dollar ranges in English copy only; with a currency not written with a dollar sign your stored figure is always used. | Extend the band pattern and pass the posting country. |
| `lib/apply/filler.js` demographic options | On near duplicate options the first in page order is taken. | Write the exact option text as your value. |
| `lib/apply/filler.js` `gateOption` | English wordings and a fixed list of negation words; another wording selects nothing and the question is left for you. | Write the option text itself as the profile value. |
| `lib/apply/filler.js` `DEGREE_LEVELS` | English degree names and common abbreviations only. | Set `degreeLevel` to the exact option text. |
| `scripts/camoufox-apply.js` | The success, spam and security code detectors are English phrase lists; a form in another language ends in submit-failed, never a false "submitted". | Phrases per language. |
| `scripts/camoufox-apply.js` location guard | An explicit "On-site" label classifies like a bare city; the residency sentence check runs only for a US only policy. | Build both country lists from `discovery.countries`. |

## Install and mirror

| Where | Ceiling | Upgrade path |
|---|---|---|
| `install-local.sh` | It copies over and never deletes, so a file removed upstream lingers in an existing install. | Write a manifest of shipped files and remove what left it. |
| `scripts/sync-agents-mirror.js` | Agent frontmatter is read as single line `key: value` pairs. | A YAML parser. |

## Limits with no comment in the code

Measured and left as they are in the last fix pass. Each is permissive or matches the behavior the port started from.

| Where | Ceiling | Upgrade path |
|---|---|---|
| `lib/rank.js` `fullScore` | With a table that stands alone, a role next to your field that names your strengths scores in the 65 to 79 band, and a posting from another field whose title shares a word with a target role is scored by the rated keywords it names. Under any other title, rated skills named open the table only as far as your material covers the posting (measured on 1361 real postings of another field: none at 65 or above for a table holding sixteen such tools). Rated terms are evidence too, though: a table holding words every field uses (leadership, communication, training), or general tools and methods other fields share (SQL, reporting, data analysis, automation, forecasting), still lifts a short posting from another field that names six or more of them to 65 and above with gate1 true where the title gate does not run (evaluate by URL, batch, a workspace with no seeds). | Keep such words out of `skills.levels` (`onboard.md` Step 6); weigh rated hits by section, or keep rated terms out of the evidence the field check reads (see `FIELD_FULL`). |
| `lib/rank.js` `buildProfile` | A table of strengths alone has trust 0, but its terms still enter the evidence vocabulary, at the level given, so a posting naming rated terms the bullets do not carry scores a point or two higher for each one: a table of ten strengths moved one posting from 44 to 56 and gate1 from false to true. | Keep rated terms out of the evidence when trust is 0. |
| `lib/rank.js` `fullScore` | A partly trusted table (many strengths, one or two rated weaknesses) can lift an adjacent role to 65 through the coverage blend. | Rate more weak skills; retune `DEFICIT`. |
| `lib/posting.js` `textClean` | A trademark sign is stored as the letters TM glued to the word before it, so a skill followed by the sign does not match in stored text. | Map the sign to a space if dedup keys allow. |
| `lib/posting.js` `parseLocation` | "Flexible / Home based" reads hybrid, because "flexible" is a hybrid word. | Phrase level hybrid patterns for the location field. |
| `lib/dedup.js` `place` | Hong Kong, Macao and Singapore count as countries, so they are never a per city dedup key or slug suffix. | A city state table. |
| `lib/profile.js` `seniorTitle` | The seniority extension applies to senior, sr, principal and lead; not to "staff", which is an entry grade in some fields. | A per user list of seniority words. |
| `lib/tailor.js` `analyzeJD` | A section whose only content is one paragraph over 260 characters lists no items. | Sentence splitting for long paragraphs. |
| `lib/tailor.js` `readsAsEnglish` | A cover letter under 30 words in another language written in pure ASCII is judged as English. | A language key in the profile. |
| `lib/tailor.js` `auditResume` | The "every bullet carries a number" check fires on a resume of 8 or more bullets when all have one; leave at least one bullet without a number. | None needed; it is the intended check. |
| `scripts/render-docx.js` | Under `output.asciiOnly` a section heading in a non Latin script falls back to English and a name in such a script is kept as written. | A transliteration table. |
| `scripts/render-docx.js` | The education entry prints on one line (degree, school, location, dates). | A two line layout option. |
| `scripts/render-cover-letter.js` | A postscript is recognized by the markers P.S., PS, P.-S. and P.D. only. | A marker list per language. |
| `scripts/verify-listing.js` | A block page (403 or another non 2xx answer with more than 1500 characters of text) is read as a live page; only 404, 410, 429, 5xx and fetch errors are handled explicitly. | Treat every non 2xx answer as unreached. |
| `scripts/verify-remote.js` | A LinkedIn "Remote" label on the posting page confirms remote even when the description states hybrid in a phrase; a "Home Based, <country>" label is read as a place. | Let the label yield to the description's phrase patterns. |
| `scripts/classify-gate.js` | It probes the EU Greenhouse host for every candidate; only a success counts. | Probe it only for boards known to be hosted there. |
| `web/` | The dashboard is not part of a global install; it runs from the clone and reads `JOBE_USER_ROOT` to show another workspace. | Ship it with `install-local.sh`. |

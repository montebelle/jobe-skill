#!/usr/bin/env node
/**
 * Standalone enrichment + ranking over an existing ranked-all.json.
 *
 * Splits the enrich step out of pipeline.js so the heavy JD-fetch + cache +
 * full-rank cycle can be re-run without rediscovering. Useful when you tweak
 * lib/rank.js signals or want to re-score yesterday's ranked set.
 *
 * Usage:
 *   node collectors/enrich-run.js [--from signals/discovered/YYYY-MM-DD] [--top 60]
 */

const fs = require('fs');
const path = require('path');
const { loadEnv, getProjectRoot } = require('../lib/config');
const { enrich } = require('../lib/enrich');
const { fullScore, fuseRanking } = require('../lib/rank');

loadEnv();

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { top: 60 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') opts.from = args[++i];
    else if (args[i] === '--top') opts.top = parseInt(args[++i], 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const root = getProjectRoot();

  // Default: yesterday's ranked-all.json (or today's if available)
  let from = opts.from;
  if (!from) {
    const days = fs.existsSync(path.join(root, 'signals/discovered'))
      ? fs.readdirSync(path.join(root, 'signals/discovered')).sort().reverse()
      : [];
    if (!days.length) { console.error('No signals/discovered/* found. Run pipeline first.'); process.exit(1); }
    from = path.join('signals/discovered', days[0]);
  }
  const rankedPath = path.join(root, from, 'ranked-all.json');
  if (!fs.existsSync(rankedPath)) { console.error(`Not found: ${rankedPath}`); process.exit(1); }

  const kept = JSON.parse(fs.readFileSync(rankedPath, 'utf8'));
  const topK = kept.slice(0, opts.top);
  console.error(`Enriching top ${topK.length} of ${kept.length} from ${from}`);

  await Promise.all(topK.map(p => enrich(p).catch(err => {
    console.error(`enrich ${p.canonicalUrl} failed: ${err.message}`);
    return p;
  })));

  for (const p of topK) {
    if (p.jdText) fullScore(p);
  }
  const refused = fuseRanking(topK);

  const outFile = path.join(root, from, 'ranked-enriched.json');
  const tmp = `${outFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(refused, null, 2));
  fs.renameSync(tmp, outFile);
  console.error(`Wrote ${outFile}`);
}

main().catch(err => { console.error(err.stack || err); process.exit(1); });

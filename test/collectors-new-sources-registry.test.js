'use strict';
// Registry check for collectors/sources: every plugin loads and has the
// contract shape, and the fourteen newer plugins stay silent (no network, no
// throw) when the user has no seed roles, no keys, no opt ins, or no tenants.
// Network is stubbed; the workspace is an empty temp directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JOBE_USER_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'collectors-new-sources-registry-'));

const SOURCES = path.join(__dirname, '..', 'collectors', 'sources');
const DIRS = ['aggregators', 'company-specific', 'ats-directories', 'ats-direct'];
const files = DIRS.flatMap(dir => fs.readdirSync(path.join(SOURCES, dir))
  .filter(f => f.endsWith('.js'))
  .map(f => path.join(SOURCES, dir, f)));
const plugins = files.map(file => ({ file, mod: require(file) }));
const byId = new Map(plugins.map(p => [p.mod.id, p]));

const SEARCH = ['findwork', 'hiring-cafe', 'indeed-camoufox', 'jobicy', 'jooble', 'usajobs'];
const FEEDS = ['arbeitnow', 'themuse', 'working-nomads'];
const TENANTS = ['bamboohr', 'breezy', 'personio', 'recruitee', 'workable'];
const NEW_IDS = [...SEARCH, ...FEEDS, ...TENANTS];

// Env switches that gate a source. Each test sets exactly what it needs and
// restores the caller's environment afterwards.
const GATES = ['FINDWORK_API_KEY', 'JOOBLE_API_KEY', 'USAJOBS_API_KEY', 'USAJOBS_EMAIL',
  'HIRING_CAFE_OPT_IN', 'INDEED_CAMOUFOX_ENABLED', 'THEMUSE_CATEGORIES'];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(GATES.map(k => [k, process.env[k]]));
  const realFetch = global.fetch;
  const calls = [];
  for (const k of GATES) delete process.env[k];
  Object.assign(process.env, values);
  global.fetch = async (url) => { calls.push(String(url)); throw new Error('network disabled in tests'); };
  try {
    return await fn(calls);
  } finally {
    global.fetch = realFetch;
    for (const k of GATES) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function makeCtx(queries, filters = {}) {
  const lines = [];
  const logger = { info: m => lines.push(m), warn: m => lines.push(m), error: m => lines.push(m) };
  return { ctx: { queries, filters, auth: {}, logger }, lines };
}

test('every file under collectors/sources is a plugin with the contract shape', () => {
  assert.ok(plugins.length >= NEW_IDS.length);
  for (const { file, mod } of plugins) {
    const where = path.relative(SOURCES, file);
    assert.equal(typeof mod.id, 'string', `${where}: id`);
    assert.match(mod.id, /^[a-z0-9-]+$/, `${where}: id is a lowercase slug`);
    assert.ok(typeof mod.name === 'string' && mod.name.trim(), `${where}: name`);
    assert.ok(Array.isArray(mod.requires) && mod.requires.every(r => typeof r === 'string'), `${where}: requires`);
    assert.ok(mod.rateLimit && Number.isFinite(mod.rateLimit.rpm) && mod.rateLimit.rpm > 0, `${where}: rateLimit.rpm`);
    assert.equal(typeof mod.discover, 'function', `${where}: discover`);
  }
  assert.equal(byId.size, plugins.length, 'plugin ids are unique');
  for (const id of NEW_IDS) assert.ok(byId.has(id), `missing plugin ${id}`);
});

test('declared requirements match the gates', () => {
  assert.deepEqual(byId.get('usajobs').mod.requires, ['USAJOBS_API_KEY', 'USAJOBS_EMAIL']);
  assert.deepEqual(byId.get('findwork').mod.requires, ['FINDWORK_API_KEY']);
  assert.deepEqual(byId.get('jooble').mod.requires, ['JOOBLE_API_KEY']);
  assert.deepEqual(byId.get('hiring-cafe').mod.requires, ['HIRING_CAFE_OPT_IN']);
  assert.deepEqual(byId.get('indeed-camoufox').mod.requires, ['INDEED_CAMOUFOX_ENABLED']);
});

test('no source carries a role vocabulary, a tenant list, or a personal User-Agent', () => {
  for (const { file } of plugins) {
    const src = fs.readFileSync(file, 'utf8');
    const where = path.relative(SOURCES, file);
    // The one argument form of rank.isRoleMatch accepts every title, so a
    // source must gate titles through lib/role-queries instead.
    assert.ok(!/require\(['"][./]+\/lib\/rank['"]\)/.test(src), `${where}: must not import lib/rank`);
  }
  for (const id of NEW_IDS) {
    const { file } = byId.get(id);
    const src = fs.readFileSync(file, 'utf8');
    // assert.ok keeps a failure message short (assert.match would print the file).
    assert.ok(!/\b(STARTER|ROLE_QUERIES|TITLE_MATCH|ROLE_MATCH|ML_REGEX|SKIP_TYPES)\b/.test(src), `${id}: hardcoded list`);
    assert.ok(/lib\/role-queries|ctx\?\.queries/.test(src), `${id}: roles must come from the user's seeds`);
    for (const ua of src.match(/jobe-discovery\/[^'"`]*/g) || []) {
      assert.equal(ua, 'jobe-discovery/1.0 (personal job search)', `${id}: User-Agent`);
    }
    assert.ok(!/\b(lat|lon|lng|latitude|longitude)\s*:/.test(src) && !/\d{1,3}\.\d{3,}/.test(src), `${id}: no coordinates`);
  }
});

test('with no seed roles every new plugin returns [] without touching the network', async () => {
  // Every gate is opened so the missing roles are the only reason to stop.
  const open = {
    FINDWORK_API_KEY: 'test-key', JOOBLE_API_KEY: 'test-key', USAJOBS_API_KEY: 'test-key',
    USAJOBS_EMAIL: 'applicant@example.org', HIRING_CAFE_OPT_IN: '1', INDEED_CAMOUFOX_ENABLED: '1',
  };
  await withEnv(open, async (calls) => {
    for (const id of NEW_IDS) {
      const filters = { atsSlugs: { [id]: ['example-tenant'] } };
      for (const queries of [[], undefined, [{ query: '   ' }]]) {
        const { ctx, lines } = makeCtx(queries, filters);
        const out = await byId.get(id).mod.discover(ctx);
        assert.deepEqual(out, [], `${id} returned postings with no seed roles`);
        assert.match(lines.join('\n'), /no seed roles/, `${id} must log why it skipped`);
      }
    }
    assert.deepEqual(calls, [], 'no network call may happen without seed roles');
  });
});

test('with seed roles but no keys, opt ins, or tenants the gated plugins stay offline', async () => {
  const seeds = [
    { query: 'Registered Nurse', location: 'Chicago, IL' },
    { query: 'Tax Accountant', location: 'Remote' },
  ];
  await withEnv({}, async (calls) => {
    for (const id of [...SEARCH.filter(s => s !== 'jobicy'), ...TENANTS]) {
      const { ctx, lines } = makeCtx(seeds);
      assert.deepEqual(await byId.get(id).mod.discover(ctx), [], id);
      assert.ok(lines.length > 0, `${id} must log why it skipped`);
    }
    assert.deepEqual(calls, [], 'a gated source reached the network');
  });
  // USAJOBS needs both variables: the key alone is not enough.
  await withEnv({ USAJOBS_API_KEY: 'test-key' }, async (calls) => {
    const { ctx, lines } = makeCtx(seeds);
    assert.deepEqual(await byId.get('usajobs').mod.discover(ctx), []);
    assert.match(lines.join('\n'), /USAJOBS_EMAIL/);
    assert.deepEqual(calls, []);
  });
  // An explicit "0" is not an opt in.
  await withEnv({ HIRING_CAFE_OPT_IN: '0', INDEED_CAMOUFOX_ENABLED: '0' }, async (calls) => {
    for (const id of ['hiring-cafe', 'indeed-camoufox']) {
      assert.deepEqual(await byId.get(id).mod.discover(makeCtx(seeds).ctx), [], id);
    }
    assert.deepEqual(calls, []);
  });
});

test('a failing network never makes a keyless plugin throw', async () => {
  const seeds = [{ query: 'Registered Nurse', location: 'Chicago, IL' }];
  await withEnv({}, async (calls) => {
    for (const id of ['jobicy', ...FEEDS]) {
      const { ctx, lines } = makeCtx(seeds);
      assert.deepEqual(await byId.get(id).mod.discover(ctx), [], id);
      assert.match(lines.join('\n'), /failed/, `${id} must log the failure`);
    }
    assert.ok(calls.length >= 4, 'each keyless plugin tried its endpoint');
  });
});

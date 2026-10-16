'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const googleJobs = require('../collectors/sources/aggregators/serpapi-google-jobs');
const siteSearch = require('../collectors/sources/aggregators/serpapi-site-search');

function quotaResponse() {
  return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
}

function context(overrides = {}) {
  const warnings = [];
  const statuses = [];
  return {
    ctx: {
      queries: [
        { query: 'Creative Director', location: 'Washington, DC' },
        { query: 'Video Producer', location: 'Remote' },
      ],
      filters: { countries: ['US'], maxAgeDays: 14, companySites: [] },
      auth: { serpApiKey: 'test-key' },
      logger: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
      reportSourceStatus: (status, reason) => statuses.push({ status, reason }),
      ...overrides,
    },
    warnings,
    statuses,
  };
}

for (const source of [googleJobs, siteSearch]) {
  test(`${source.id}: first 429 stops the source and records degraded quota state`, async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return quotaResponse(); };
    const { ctx, warnings, statuses } = context();
    try {
      const rows = await source.discover(ctx);
      assert.deepEqual(rows, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(calls, 1, 'a quota response must not retry or continue to the next query');
    assert.deepEqual(statuses, [{ status: 'degraded', reason: 'quota_exhausted' }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stopping this source after the first 429/);
  });
}

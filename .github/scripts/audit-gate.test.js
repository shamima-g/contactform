#!/usr/bin/env node
/**
 * Tests for audit-gate.js
 *
 * audit-gate.js shells out to `npm audit`, which needs a real project with
 * installed dependencies — so rather than run the whole CLI, these tests
 * exercise its pure decision logic against fixture npm-audit JSON. That logic is
 * what each acceptance criterion turns on: which advisories block, which are
 * advisory-only, and how time-boxed exceptions are honoured and expire.
 *
 * No test framework required — uses Node's built-in runner:
 *
 *   node --test .github/scripts/
 *   node --test .github/scripts/audit-gate.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  severityLabel,
  ghsaFromUrl,
  collectAdvisories,
  countBySeverity,
  findException,
  classify,
  loadExceptions,
} = require('./audit-gate.js');

// A fixed "now" so expiry tests are deterministic.
const NOW = Date.parse('2026-06-23T00:00:00Z');

/** Build a minimal npm-audit-shaped report with one advisory per package. */
function auditWith(advisories) {
  const vulnerabilities = {};
  const counts = { critical: 0, high: 0, moderate: 0, low: 0 };
  advisories.forEach((a) => {
    counts[a.severity] = (counts[a.severity] || 0) + 1;
    vulnerabilities[a.pkg] = {
      name: a.pkg,
      severity: a.severity,
      fixAvailable: a.fixAvailable ?? false,
      via: [
        {
          source: a.source,
          name: a.pkg,
          title: a.title || 'Some advisory',
          url: a.url || `https://github.com/advisories/${a.ghsa}`,
          severity: a.severity,
        },
      ],
    };
  });
  return { vulnerabilities, metadata: { vulnerabilities: counts } };
}

describe('severityLabel', () => {
  test('maps npm "moderate" to "Medium"', () => {
    assert.equal(severityLabel('moderate'), 'Medium');
    assert.equal(severityLabel('critical'), 'Critical');
    assert.equal(severityLabel('high'), 'High');
    assert.equal(severityLabel('low'), 'Low');
  });
});

describe('ghsaFromUrl', () => {
  test('extracts a GHSA id from an advisory url', () => {
    assert.equal(
      ghsaFromUrl('https://github.com/advisories/GHSA-1234-abcd-5678'),
      'GHSA-1234-abcd-5678',
    );
  });
  test('returns null when there is no GHSA id', () => {
    assert.equal(ghsaFromUrl('https://example.com/x'), null);
    assert.equal(ghsaFromUrl(null), null);
  });
});

describe('collectAdvisories', () => {
  test('keys advisories by GHSA id and records the affected package', () => {
    const json = auditWith([
      { pkg: 'lodash', severity: 'high', ghsa: 'GHSA-aaaa-bbbb-cccc', source: 111 },
    ]);
    const advisories = collectAdvisories(json);
    assert.equal(advisories.size, 1);
    const a = advisories.get('GHSA-aaaa-bbbb-cccc');
    assert.ok(a);
    assert.equal(a.severity, 'high');
    assert.deepEqual([...a.packages], ['lodash']);
  });

  test('ignores string `via` entries (transitive references)', () => {
    const json = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: ['b'] },
      },
      metadata: { vulnerabilities: { high: 1 } },
    };
    assert.equal(collectAdvisories(json).size, 0);
  });
});

describe('countBySeverity', () => {
  test('counts each advisory, not packages — one package with several advisories', () => {
    // npm's metadata would report this as 1 critical package; collectAdvisories
    // yields one advisory per `via` entry, and we count those.
    const json = {
      vulnerabilities: {
        lodash: {
          name: 'lodash',
          severity: 'critical',
          fixAvailable: true,
          via: [
            { source: 1, name: 'lodash', title: 'crit', url: 'https://github.com/advisories/GHSA-crit-crit-crit', severity: 'critical' },
            { source: 2, name: 'lodash', title: 'high a', url: 'https://github.com/advisories/GHSA-high-aaaa-1111', severity: 'high' },
            { source: 3, name: 'lodash', title: 'high b', url: 'https://github.com/advisories/GHSA-high-bbbb-2222', severity: 'high' },
            { source: 4, name: 'lodash', title: 'high c', url: 'https://github.com/advisories/GHSA-high-cccc-3333', severity: 'high' },
            { source: 5, name: 'lodash', title: 'mod', url: 'https://github.com/advisories/GHSA-modd-dddd-4444', severity: 'moderate' },
          ],
        },
      },
      metadata: { vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0, total: 1 } },
    };
    const counts = countBySeverity(collectAdvisories(json));
    assert.deepEqual(counts, { critical: 1, high: 3, moderate: 1, low: 0 });
  });

  test('ignores severities outside the four reported buckets', () => {
    const advisories = new Map([
      ['GHSA-a', { severity: 'low' }],
      ['GHSA-b', { severity: 'info' }],
      ['GHSA-c', { severity: '' }],
    ]);
    assert.deepEqual(countBySeverity(advisories), { critical: 0, high: 0, moderate: 0, low: 1 });
  });

  test('returns all-zero for no advisories', () => {
    assert.deepEqual(countBySeverity(new Map()), { critical: 0, high: 0, moderate: 0, low: 0 });
  });
});

describe('classify (severity policy)', () => {
  test('Critical and High block; Medium and Low are advisory-only', () => {
    const json = auditWith([
      { pkg: 'crit-pkg', severity: 'critical', ghsa: 'GHSA-crit-crit-crit', source: 1 },
      { pkg: 'high-pkg', severity: 'high', ghsa: 'GHSA-high-high-high', source: 2 },
      { pkg: 'mod-pkg', severity: 'moderate', ghsa: 'GHSA-modd-modd-modd', source: 3 },
      { pkg: 'low-pkg', severity: 'low', ghsa: 'GHSA-loww-loww-loww', source: 4 },
    ]);
    const { blocking, advisoryOnly } = classify(collectAdvisories(json), {}, NOW);

    assert.equal(blocking.length, 2, 'critical + high block');
    assert.deepEqual(
      blocking.map((a) => a.severity).sort(),
      ['critical', 'high'],
    );
    assert.equal(advisoryOnly.length, 2, 'moderate + low are advisory only');
  });

  test('no blocking advisories when only Medium/Low exist', () => {
    const json = auditWith([
      { pkg: 'mod-pkg', severity: 'moderate', ghsa: 'GHSA-modd-modd-modd', source: 3 },
    ]);
    const { blocking } = classify(collectAdvisories(json), {}, NOW);
    assert.equal(blocking.length, 0);
  });

  test('blocking advisories are ordered most-serious first', () => {
    // Discovery order is High, Critical, High — the report must reorder it.
    const json = auditWith([
      { pkg: 'aaa', severity: 'high', ghsa: 'GHSA-high-aaaa-1111', source: 1 },
      { pkg: 'bbb', severity: 'critical', ghsa: 'GHSA-crit-bbbb-2222', source: 2 },
      { pkg: 'ccc', severity: 'high', ghsa: 'GHSA-high-cccc-3333', source: 3 },
    ]);
    const { blocking } = classify(collectAdvisories(json), {}, NOW);
    assert.deepEqual(
      blocking.map((a) => a.severity),
      ['critical', 'high', 'high'],
    );
  });
});

describe('classify (time-boxed exceptions)', () => {
  const json = auditWith([
    { pkg: 'no-fix-pkg', severity: 'high', ghsa: 'GHSA-nofx-nofx-nofx', source: 42 },
  ]);

  test('a valid (unexpired) exception moves the advisory out of blocking', () => {
    const exceptions = {
      'GHSA-nofx-nofx-nofx': { reason: 'no upstream fix', expires: '2026-09-01' },
    };
    const { blocking, excepted } = classify(collectAdvisories(json), exceptions, NOW);
    assert.equal(blocking.length, 0);
    assert.equal(excepted.length, 1);
    assert.equal(excepted[0].exception.expires, '2026-09-01');
  });

  test('an expired exception does NOT protect — advisory blocks again', () => {
    const exceptions = {
      'GHSA-nofx-nofx-nofx': { reason: 'no upstream fix', expires: '2026-01-01' },
    };
    const { blocking, excepted, staleExceptions } = classify(
      collectAdvisories(json),
      exceptions,
      NOW,
    );
    assert.equal(blocking.length, 1, 'expired exception no longer protects');
    assert.equal(excepted.length, 0);
    assert.ok(staleExceptions.some((e) => e.why === 'expired on 2026-01-01'));
  });

  test('an exception only applies to the advisory it names', () => {
    const exceptions = {
      'GHSA-different-one-here': { reason: 'unrelated', expires: '2099-01-01' },
    };
    const { blocking } = classify(collectAdvisories(json), exceptions, NOW);
    assert.equal(blocking.length, 1, 'a non-matching exception does not help');
  });

  test('matches by numeric npm source id too', () => {
    const exceptions = { 42: { reason: 'no fix', expires: '2099-01-01' } };
    const { blocking, excepted } = classify(collectAdvisories(json), exceptions, NOW);
    assert.equal(blocking.length, 0);
    assert.equal(excepted.length, 1);
  });

  test('an exception with an invalid expiry does not protect', () => {
    const exceptions = { 'GHSA-nofx-nofx-nofx': { reason: 'x', expires: 'soon' } };
    const { blocking, staleExceptions } = classify(collectAdvisories(json), exceptions, NOW);
    assert.equal(blocking.length, 1);
    assert.ok(staleExceptions.some((e) => e.why.startsWith('invalid expiry date "soon"')));
  });

  test('an exception with no expiry date is reported as missing one', () => {
    const exceptions = { 'GHSA-nofx-nofx-nofx': { reason: 'forgot the date' } };
    const { blocking, staleExceptions } = classify(collectAdvisories(json), exceptions, NOW);
    assert.equal(blocking.length, 1);
    assert.ok(staleExceptions.some((e) => e.why === 'missing an expiry date'));
  });
});

describe('loadExceptions', () => {
  /** Run `fn` against a temp web/ folder containing the given dependency-audit-exceptions.json body. */
  function withExceptionsFile(body, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
    if (body !== undefined) {
      fs.writeFileSync(path.join(dir, 'dependency-audit-exceptions.json'), body);
    }
    try {
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('missing file is not an error — empty map', () => {
    withExceptionsFile(undefined, (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.deepEqual(map, {});
      assert.equal(error, null);
    });
  });

  test('reads a flat object keyed by advisory id', () => {
    withExceptionsFile('{ "GHSA-aaaa-bbbb-cccc": { "reason": "x", "expires": "2099-01-01" } }', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.equal(error, null);
      assert.equal(map['GHSA-aaaa-bbbb-cccc'].expires, '2099-01-01');
    });
  });

  test('reads the { advisories: {...} } wrapper shape', () => {
    withExceptionsFile('{ "advisories": { "GHSA-aaaa-bbbb-cccc": { "expires": "2099-01-01" } } }', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.equal(error, null);
      assert.equal(map['GHSA-aaaa-bbbb-cccc'].expires, '2099-01-01');
    });
  });

  test('malformed JSON drops all exceptions and reports an error', () => {
    withExceptionsFile('{ not valid json', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.deepEqual(map, {});
      assert.ok(error, 'an error message is surfaced');
    });
  });

  test('valid JSON of the wrong type (string) is rejected with an error, not swallowed', () => {
    withExceptionsFile('"oops"', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.deepEqual(map, {});
      assert.ok(error, 'a string is not a valid exceptions map');
    });
  });

  test('valid JSON of the wrong type (array) is rejected with an error', () => {
    withExceptionsFile('["GHSA-aaaa-bbbb-cccc"]', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.deepEqual(map, {});
      assert.ok(error, 'an array is not a valid exceptions map');
    });
  });

  test('JSON null is rejected with an error', () => {
    withExceptionsFile('null', (dir) => {
      const { map, error } = loadExceptions(dir);
      assert.deepEqual(map, {});
      assert.ok(error);
    });
  });
});

describe('findException', () => {
  const advisory = { id: 'GHSA-nofx-nofx-nofx', source: 42 };

  test('reports "none" when no exception is recorded', () => {
    assert.equal(findException(advisory, {}, NOW).status, 'none');
  });
  test('reports "valid" for an unexpired match', () => {
    const r = findException(advisory, { 'GHSA-nofx-nofx-nofx': { expires: '2099-01-01' } }, NOW);
    assert.equal(r.status, 'valid');
  });
  test('reports "expired" for a past expiry', () => {
    const r = findException(advisory, { 'GHSA-nofx-nofx-nofx': { expires: '2000-01-01' } }, NOW);
    assert.equal(r.status, 'expired');
  });
});

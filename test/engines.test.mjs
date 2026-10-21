// Guards the `engines` field in package.json: the Node versions it admits are
// versions on which the package loads. The engine, `@opena2a/aim-sdk`, loads
// `@noble/ed25519`, an ES module, with `require()`. While the field read
// `>=18.0.0`, it admitted Node 18.20.8, on which a `require` of the package
// failed with ERR_REQUIRE_ESM.
//
// FAILS and LOADS are measurements, made on 2026-10-21 with the engine version
// in MEASURED_WITH: a `require('./dist/index.js')` of a build of this package,
// run in the `node` container image of each version, failed with
// ERR_REQUIRE_ESM on each version in FAILS and loaded on each version in LOADS,
// on 23.0.0 with an ExperimentalWarning on stderr. Another engine version can
// load on other versions, so a change of the pin in package.json is a reason to
// measure them again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const MEASURED_WITH = '1.3.1'
const FAILS = ['18.20.8', '20.18.3', '21.7.3', '22.11.0']
const LOADS = ['20.19.0', '20.20.2', '22.12.0', '22.23.3', '23.0.0', '24.22.0', '26.12.0']

// The three parts of a version written x.y.z, as numbers.
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text)
  assert.ok(match, `\`${text}\` is not a version written x.y.z`)
  return match.slice(1).map(Number)
}

// Whether `version`, written x.y.z, satisfies `range`: sets of comparators
// separated by `||`, of which at least one holds. A set holds when each of its
// comparators, separated by spaces, holds. A comparator is `^`, `>=`, `>`,
// `<=`, `<` or `=`, or none, which is `=`, followed by a version written x.y.z.
// The whole range is read before any of it is compared, so a range in another
// form, such as `>=20`, `~20.19.0` or `20.x`, fails an assertion here rather
// than being read some other way.
function satisfies(version, range) {
  const v = parseVersion(version)
  const sets = range.split('||').map((set) =>
    set
      .trim()
      .split(/\s+/)
      .map((comparator) => {
        const [, operator = '=', text = comparator] = /^(\^|>=|>|<=|<|=)?(\S+)$/.exec(comparator) ?? []
        return { operator, bound: parseVersion(text) }
      }),
  )
  return sets.some((set) =>
    set.every(({ operator, bound }) => {
      const sign = v[0] - bound[0] || v[1] - bound[1] || v[2] - bound[2]
      switch (operator) {
        // `^x.y.z` admits the versions from x.y.z on that keep its parts up to
        // the first that is not 0, or all three when each is 0.
        case '^': {
          const kept = bound[0] > 0 ? 1 : bound[1] > 0 ? 2 : 3
          return sign >= 0 && bound.slice(0, kept).every((part, i) => v[i] === part)
        }
        case '>=':
          return sign >= 0
        case '>':
          return sign > 0
        case '<=':
          return sign <= 0
        case '<':
          return sign < 0
        default:
          return sign === 0
      }
    }),
  )
}

test('a range is read as npm reads it, for comparators on versions written x.y.z, and a range in another form is refused', () => {
  const cases = [
    ['18.20.8', '>=18.0.0', true],
    ['20.18.3', '^20.19.0 || >=22.12.0', false],
    ['20.19.0', '^20.19.0 || >=22.12.0', true],
    ['21.7.3', '^20.19.0 || >=22.12.0', false],
    ['22.11.0', '^20.19.0 || >=22.12.0', false],
    ['26.12.0', '^20.19.0 || >=22.12.0', true],
    ['20.5.0', '>20.4.9 <=20.5.0', true],
    ['20.5.1', '>20.4.9 <=20.5.0', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.4', '^0.0.3', false],
    ['22.12.0', '22.12.0', true],
    ['22.12.1', '=22.12.0', false],
  ]
  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `${version} against \`${range}\``)
  }
  for (const range of ['>=20', '~20.19.0', '20.x', '*', '>= 20.19.0', '20.19.0 - 22.0.0', '^20.19.0 || >=22', '']) {
    assert.throws(() => satisfies('20.19.0', range), assert.AssertionError, `\`${range}\` was read`)
  }
})

test('the engines field admits none of the Node versions on which a require of the package failed', () => {
  const range = rootPackage.engines?.node
  assert.equal(typeof range, 'string', 'package.json sets no `engines.node`')
  assert.deepEqual(
    FAILS.filter((version) => satisfies(version, range)),
    [],
    `the engines field, \`${range}\`, admits Node versions on which the package does not load`,
  )
})

test('the engines field admits each of the Node versions on which the package loaded', () => {
  const range = rootPackage.engines.node
  assert.deepEqual(
    LOADS.filter((version) => !satisfies(version, range)),
    [],
    `the engines field, \`${range}\`, refuses Node versions on which the package loads`,
  )
})

test('the versions were measured with the engine version package.json pins', () => {
  assert.equal(rootPackage.dependencies['@opena2a/aim-sdk'], MEASURED_WITH)
})

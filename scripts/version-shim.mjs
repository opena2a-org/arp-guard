// Run by `npm version`, through the `version` script in package.json, after it
// has written the new version to package.json and before it commits. Gives the
// `arp-guard` shim in shim/arp-guard the same version and pins the shim's
// dependency on this package to it, as test/shim.test.mjs requires; the
// `version` script then stages the file, so a commit and tag made by
// `npm version` carry both.
//
// Without it, `npm version` left the shim at the old version and
// test/shim.test.mjs failed. `npm test` runs that file, and the release
// workflow runs `npm test` before it publishes.

import { readFileSync, writeFileSync } from 'node:fs'

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'))

const rootPackage = readJson(new URL('../package.json', import.meta.url))
const shimFile = new URL('../shim/arp-guard/package.json', import.meta.url)
const shim = readJson(shimFile)

shim.version = rootPackage.version
shim.dependencies[rootPackage.name] = rootPackage.version
writeFileSync(shimFile, `${JSON.stringify(shim, null, 2)}\n`)

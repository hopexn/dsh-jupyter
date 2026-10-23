/**
 * Run every test suite in one command.
 *
 * The five offline suites need nothing but Node, so they always run. `e2e` and `register` need a
 * live Jupyter server and (for `register`) the DSH packages; running them against a server that
 * is not there produces a wall of connection errors that says nothing about the change. They are
 * therefore included only when `JUPYTER_TEST_URL` is set:
 *
 *   npm test
 *   JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=... npm test
 *
 * @module dsh-jupyterlab/scripts/test-all
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Suites that never touch the network. */
const OFFLINE = [
  'test/transport.mjs',
  'test/ipynb.mjs',
  'test/notebook.mjs',
  'test/activity.mjs',
  'test/client.mjs',
]

/** Suites that need a running Jupyter server. */
const ONLINE = ['test/e2e.mjs', 'test/register.mjs']

const suites = [...OFFLINE, ...(process.env.JUPYTER_TEST_URL === undefined ? [] : ONLINE)]
const totals = []

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`)
  const result = spawnSync(process.execPath, [suite], { cwd: root, stdio: 'inherit' })
  totals.push({ suite, status: result.status ?? 1 })
}

const failed = totals.filter((entry) => entry.status !== 0)
console.log(`\n${totals.length - failed.length}/${totals.length} suites passed`)
if (process.env.JUPYTER_TEST_URL === undefined) {
  console.log('(e2e and register skipped; set JUPYTER_TEST_URL to include them)')
}
if (failed.length > 0) {
  for (const entry of failed) console.error(`  FAILED ${entry.suite}`)
  process.exit(1)
}

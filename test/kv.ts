import 'mocha'
import fdb = require('../lib')
import assert = require('assert')
import {
  prefix,
  numToBuf,
  bufToNum,
} from './util'

process.on('unhandledRejection', err => { throw err.stack })

// These tests just use a single shared database instance which is reset
// between tests. It would be cleaner if we used beforeEach to close & reopen
// the database but its probably fine like this.
const db = fdb.openSync()

// We need to do this both before and after tests run to clean up any mess
// that a previously aborted test left behind.
beforeEach(() => db.clearRangeStartsWith(prefix))
afterEach(() => db.clearRangeStartsWith(prefix))

describe('key value functionality', () => {
  it('reads its writes inside a txn', async () => {
    await db.doTransaction(async tn => {
      const key = prefix + 'xxx'
      const val = Buffer.from('hi there')

      tn.set(key, val)

      const result = await tn.get(key)
      assert.deepStrictEqual(result, val)
    })
  })

  it('reads its writes in separate transactions', async () => {
    const key = prefix + 'xxx'
    const val = Buffer.from('hi there')

    await db.doTransaction(async tn => {
      tn.set(key, val)
    })

    await db.doTransaction(async tn => {
      const result = await tn.get(key)
      assert.deepStrictEqual(result, val)
    })
  })

  it('lets you read and write via the database directly', async () => {
    const key = prefix + 'xxx'
    const val = Buffer.from('hi there')
    await db.set(key, val)
    const result = await db.get(key)
    assert.deepStrictEqual(result, val)
  })

  it('returns the user value from db.doTransaction', async () => {
    const val = {}
    const result = await db.doTransaction(async tn => val)
    assert.strictEqual(val, result)
  })

  it('lets you cancel a txn')

  it('retries conflicts', async function() {
    this.slow(2000)
    const concurrentWrites = 30
    const key = prefix + 'num'

    await db.set(key, numToBuf(0))

    let txnAttempts = 0
    await Promise.all(new Array(concurrentWrites).fill(0).map((_, i) => (
      db.doTransaction(async tn => {
        const val = bufToNum(await tn.get(key))
        tn.set(key, numToBuf(val + 1))
        txnAttempts++
      })
    )))

    const result = bufToNum(await db.get(key))
    assert.strictEqual(result, concurrentWrites)

    // This doesn't necessarily mean there's an error, but if there weren't
    // more attempts than there were increments, the database is running
    // serially and this test is doing nothing.
    assert(txnAttempts > concurrentWrites)
  })
})
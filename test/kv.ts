import 'mocha'
import assert = require('assert')
import {
  prefix as testPrefix,
  strXF,
  numToBuf,
  bufToNum,
  withEachDb,
} from './util'
import {MutationType, tuple, TupleItem, encoders, Watch, keySelector} from '../lib'
import {Transformer} from '../lib/transformer'

process.on('unhandledRejection', err => { throw err })

// Unfortunately assert.rejects doesn't work properly in node 8. For now we'll use a shim.
const assertRejects = async (p: Promise<any>) => {
  try {
    await p
    throw Error('Promise resolved instead of erroring')
  } catch (e) {}
}

const codeBuf = (code: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(code, 0)
  return b
}
const bakeVersionstamp = (vs: Buffer, code: number): TupleItem => ({
  type: 'versionstamp', value: Buffer.concat([vs, codeBuf(code)])
})

withEachDb(db => describe('key value functionality', () => {
  describe('encoder', () => {
    const setGetAssertEqual = async (val: any, valueEncoding: Transformer<any, any>) => {
      await db.withKeyEncoding(encoders.string).withValueEncoding(valueEncoding).doTransaction(async tn => {
        tn.set('xxx', val)
        const result = await tn.get('xxx')
        assert.deepStrictEqual(result, val)
      })
    }

    for (const jsonStringifyLength of [1023,1024,1025]) {
      it(`handles ${jsonStringifyLength} length json`, async () => {
        await setGetAssertEqual(Array.from({length: jsonStringifyLength - 2}, (_, x) => (x % 10) + '').join(''), encoders.json)
      })
    }
  })

  it('reads its writes inside a txn', async () => {
    await db.doTransaction(async tn => {
      const val = Buffer.from('hi there')
      tn.set('xxx', val)

      const result = await tn.get('xxx')
      assert.deepStrictEqual(result, val)
    })
  })

  it.skip("returns undefined when keys don't exist in get() and getKey", async () => {
    await db.doTn(async tn => {
      console.log(await tn.getKey('doesnotexist'))
      // assert.strictEqual(await tn.get('doesnotexist'), undefined)
      assert.strictEqual(await tn.getKey('doesnotexist'), undefined)
    })
    // assert.strictEqual(await db.get('doesnotexist'), undefined)
    // assert.strictEqual(await db.getKey('doesnotexist'), undefined)
  })

  it('reads its writes in separate transactions', async () => {
    const val = Buffer.from('hi there')

    await db.doTransaction(async tn => {
      tn.set('xxx', val)
    })

    await db.doTransaction(async tn => {
      const result = await tn.get('xxx')
      assert.deepStrictEqual(result, val)
    })
  })

  it('lets you read and write via the database directly', async () => {
    const val = Buffer.from('hi there')
    await db.set('xxx', val)
    const result = await db.get('xxx')
    assert.deepStrictEqual(result, val)
  })

  it('returns the user value from db.doTransaction', async () => {
    const val = {}
    const result = await db.doTransaction(async tn => val)
    assert.strictEqual(val, result)
  })

  it.skip('lets you cancel a txn', async () => {
    // So right now when you cancel a transaction db.doTransaction throws with
    // a transaction_cancelled error. I'm not sure if this API is what we want?
    await db.doTransaction(async tn => {
      tn.rawCancel()
    })
  })

  it('obeys transaction options', async function() {
    // We can't test all the options, but we can test at least one.
    await db.doTransaction(async tn => {
      tn.set('x', 'hi there')
      assert.equal(await tn.get('x'), null)
    }, {read_your_writes_disable: true})
  })

  it('retries conflicts', async function() {
    // Transactions do exponential backoff when they conflict, so the time
    // this test takes to run is super variable based on how unlucky we get
    // with concurrency.
    this.slow(3000)
    this.timeout(10000)

    const concurrentWrites = 30
    const key = 'num'

    await db.set(key, numToBuf(0))

    let txnAttempts = 0
    await Promise.all(new Array(concurrentWrites).fill(0).map((_, i) => (
      db.doTransaction(async tn => {
        const val = bufToNum((await tn.get(key)) as Buffer)
        tn.set(key, numToBuf(val + 1))
        txnAttempts++
      })
    )))

    const result = bufToNum((await db.get(key)) as Buffer)
    assert.strictEqual(result, concurrentWrites)

    // This doesn't necessarily mean there's an error, but if there weren't
    // more attempts than there were increments, the database is running
    // serially and this test is doing nothing.
    assert(txnAttempts > concurrentWrites)
  })

  describe('getKey', () => {
    it('returns the exact key requested', async () => {
      await db.set('x', 'y')
      assert.strictEqual((await db.getKey('x'))?.toString(), 'x')
    })

    it('returns undefined if there is no key that matches', async () => {
      assert.strictEqual(await db.getKey('doesnotexist'), undefined)
    })

    it('returns the key that matches if a key selector is passed', async () => {
      await db.set('a', 'y')
      await db.set('b', 'y')
      assert.strictEqual((await db.getKey(keySelector.firstGreaterThan('a')))?.toString(), 'b')
    })

    it('returns undefined if the key selector matches outside of the subspace range', async () => {
      await db.at('b').set('key', 'val')

      const _db = db.at('a')

      assert.strictEqual(await _db.getKey(keySelector('', true, 0)), undefined)
    })
  })

  describe('version stamps', () => {
    it('handles setVersionstampSuffixedKey correctly', async () => {
      const keyPrefix = Buffer.from('hi there')
      const keySuffix = Buffer.from('xxyy')
      // console.log('suffix', keySuffix)
      await db.setVersionstampSuffixedKey(keyPrefix, Buffer.from('yo yo'), keySuffix)

      const result = await db.getRangeAllStartsWith(keyPrefix)
      // console.log('r', result)
      assert.strictEqual(result.length, 1)
      const [keyResult, valResult] = result[0]

      // console.log('val', keyResult)

      // keyResult should be (keyPrefix) (10 bytes of stamp) (2 byte user suffix) (keySuffix).
      assert.strictEqual(keyResult.length, keyPrefix.length + 10 + keySuffix.length)
      const actualPrefix = keyResult.slice(0, keyPrefix.length)
      const actualStamp = keyResult.slice(keyPrefix.length, keyPrefix.length + 10)
      const actualSuffix = keyResult.slice(keyPrefix.length + 10)
      
      assert.deepStrictEqual(actualPrefix, keyPrefix)
      assert.deepStrictEqual(actualSuffix, keySuffix)

      // console.log('stamp', actualStamp)

      assert.strictEqual(valResult.toString(), 'yo yo')
    })

    it('handles setVersionstampedValue', async () => {
      const db_ = db.withValueEncoding(strXF)
      await db_.setVersionstampPrefixedValue('hi there', 'yooo')
      
      const result = await db_.getVersionstampPrefixedValue('hi there')
      assert(result != null)

      const {stamp, value} = result!
      assert.strictEqual(stamp.length, 10) // Opaque.
      assert.strictEqual(value, 'yooo')
    })

    it('roundtrips a tuple key', async () => {
      const db_ = db.withKeyEncoding(encoders.tuple)
      await db_.set([1,2,3], 'hi there')
      const result = await db_.get([1,2,3])
      assert.strictEqual(result!.toString('utf8'), 'hi there')
    })

    it('commits a tuple with unbound key versionstamps and bakes the vs and code', async () => {
      const db_ = db.withKeyEncoding(encoders.tuple).withValueEncoding(encoders.string)
      const key1: TupleItem[] = [1,2,3, tuple.unboundVersionstamp()] // should end up with code 0
      const key2: TupleItem[] = [1,2,3, tuple.unboundVersionstamp()] // code 1
      const key3: TupleItem[] = [1,2,3, tuple.unboundVersionstamp(321)] // code 321

      const actualStamp = await (await db_.doTn(async tn => {
        tn.setVersionstampedKey(key1, '1')
        tn.setVersionstampedKey(key2, '2')
        tn.setVersionstampedKey(key3, '3')
        return tn.getVersionstamp()
      })).promise

      // await db_.setVersionstampedKey(key1, 'hi there')

      // The versionstamp should have been baked into the object
      assert.deepStrictEqual(key1[3], bakeVersionstamp(actualStamp, 0))
      assert.deepStrictEqual(key2[3], bakeVersionstamp(actualStamp, 1))
      assert.deepStrictEqual(key3[3], bakeVersionstamp(actualStamp, 321))

      // const results = await db.getRangeAllStartsWith(tuple.packBound([1,2,3]))
      // assert.strictEqual(results.length, 1)
      const results = await db_.getRangeAllStartsWith([1,2,3])

      assert.deepStrictEqual(results, [
        [key1, '1'],
        [key2, '2'],
        [key3, '3'],
      ])
    })

    it('does not bake the vs in setVersionstampedKey(bakeAfterCommit=false)', async () => {
      const db_ = db.withKeyEncoding(encoders.tuple)
      const key: TupleItem[] = [1,2,3, {type: 'unbound versionstamp'}]
      await db_.setVersionstampedKey(key, 'hi', false)
      
      assert.deepStrictEqual(key, [1,2,3, {type: 'unbound versionstamp'}])
    })

    it('bakes versionstamps in a subspace', async () => {
      const subspace = db.withValueEncoding(encoders.tuple);

      const value = await db.doTransaction(async tn => {
        const value = [tuple.unboundVersionstamp()]
        tn.scopedTo(subspace).setVersionstampedValue('some-key', value)
        return value
      })

      assert.strictEqual((value as any)[0].type, 'versionstamp')
    })

    it('encodes versionstamps in child tuples', async () => {
      const db_ = db.withKeyEncoding(encoders.tuple).withValueEncoding(encoders.string)
      const key: any[] = [1,[2, {type: 'unbound versionstamp'}]]

      const actualStamp = await (await db_.doTn(async tn => {
        tn.setVersionstampedKey(key, 'hi there')
        return tn.getVersionstamp()
      })).promise

      // Check its been baked
      assert.deepStrictEqual(key, [1,[2, bakeVersionstamp(actualStamp, 0)]])

      const results = await db_.getRangeAllStartsWith([])
      assert.deepStrictEqual(results, [[key, 'hi there']])
    })

    it('resets the code in retried transactions')

    it('commits a tuple with unbound value versionstamps and bakes the vs and code', async () => {
      const db_ = db.withKeyEncoding(encoders.string).withValueEncoding(encoders.tuple)
      const val1: TupleItem[] = [1,2,3, {type: 'unbound versionstamp'}, 5] // code 1
      const val2: TupleItem[] = [1,2,3, {type: 'unbound versionstamp'}] // code 2
      const val3: TupleItem[] = [1,2,3, {type: 'unbound versionstamp', code: 321}] // code 321

      const actualStamp = await (await db_.doTn(async tn => {
        tn.setVersionstampedValue('1', val1)
        tn.setVersionstampedValue('2', val2)
        tn.setVersionstampedValue('3', val3)
        return tn.getVersionstamp()
      })).promise

      // await db_.setVersionstampedKey(key1, 'hi there')

      // The versionstamp should have been baked into the object
      assert.deepStrictEqual(val1[3], bakeVersionstamp(actualStamp, 0))
      assert.deepStrictEqual(val2[3], bakeVersionstamp(actualStamp, 1))
      assert.deepStrictEqual(val3[3], bakeVersionstamp(actualStamp, 321))

      // const results = await db.getRangeAllStartsWith(tuple.packBound([1,2,3]))
      // assert.strictEqual(results.length, 1)
      const results = await db_.getRangeAllStartsWith('')

      assert.deepStrictEqual(results, [
        ['1', val1],
        ['2', val2],
        ['3', val3],
      ])
    })

    it('does not crash the program if a getVersionstamp result is aborted due to conflict', async () => {
      // We're going to artificially generate a transaction conflict
      const tn1 = db.rawCreateTransaction()
      const tn2 = db.rawCreateTransaction()
      await tn1.get('x')
      tn1.set('x', 'hi')

      await tn2.get('x')
      tn2.set('x', 'yo')

      await tn1.rawCommit()

      // This will fail, but it shouldn't crash the program.
      const vs = tn2.getVersionstamp().promise

      // This will throw
      try { await tn2.rawCommit() } catch (e) {}
    })
  })

  describe('watch', () => {
    it('getAndWatch returns undefined for empty keys', async () => {
      const watch = await db.getAndWatch('hi')
      assert.strictEqual(watch.value, undefined)
      await db.set('hi', 'yo')
      assert.strictEqual(true, await watch.promise)
    })

    it('getAndWatch returns a value when there is one', async () => {
      await db.set('foo', 'bar')
      const watch = await db.getAndWatch('foo')
      assert.deepStrictEqual(watch.value, Buffer.from('bar'))
      watch.cancel()
      assert.strictEqual(false, await watch.promise)
      // await new Promise(resolve => setTimeout(resolve, 200))
    })

    it('resolves false if the transaction conflicts', async () => {
      // Artificially creating a conflict to see what happens.
      const tn1 = db.rawCreateTransaction()
      tn1.addReadConflictKey('conflict')
      tn1.addWriteConflictKey('conflict')
      const watch = tn1.watch('x')

      const tn2 = db.rawCreateTransaction()
      tn2.addWriteConflictKey('conflict')
      await tn2.rawCommit()

      await tn1.rawCommit().catch(e => {})

      watch.cancel()

      // Should resolve with false.
      assert.strictEqual(false, await watch.promise)
    })
    
    it('resolves false if the transaction is cancelled', async () => {
      const tn = db.rawCreateTransaction()
      const watch = tn.watch('x')
      tn.rawCancel()
      assert.strictEqual(false, await watch.promise)
    })
    
    it('errors if a real error happens', async () => {
      // This is a regression. And this is a bit of an ugly test
      
      let watch: Watch
      await assertRejects(db.doTn(async tn => {
        tn.setReadVersion(Buffer.alloc(8)) // All zeros. This should be too old
        watch = tn.watch('x')
        await tn.get('x') // this will fail and throw.
      }))

      await assertRejects(watch!.promise)
    })
  })

  describe('callback API', () => {
    // Unless benchmarking shows a significant difference, this will be removed
    // in a future version of this library.
    it('allows tn.get() with a callback', async () => {
      let called = false
      await db.doTransaction(async tn => {
        tn.set('xxx', 'hi')

        // Ok now fetch it. I'm wrapping this in an awaited promise so we don't
        // commit the transaction before .get() has resolved.
        await new Promise<void>((resolve, reject) => {
          tn.get('xxx', (err, data) => {
            try {
              assert(!called)
              called = true
              if (err) throw err
              assert.deepStrictEqual(data, Buffer.from('hi'))
              resolve()
            } catch (e) { reject(e) }
          })
        })
      })
      assert(called)
    })
    
  })

  describe('regression', () => {
    it('does not trim off the end of a string', async () => {
      // https://github.com/josephg/node-foundationdb/issues/40
      const _db = db.getRoot()

      await _db.set(testPrefix + 'somekey', 'val')
      const val = await _db.get(testPrefix + 'somekey')
      assert.strictEqual(val?.toString(), 'val')
    })
  })
}))

import 'mocha'
import fdb = require('../lib')
import assert = require('assert')
import {
  numXF,
  withEachDb,
} from './util'
import {counterEncoding, HighContentionAllocator} from '../lib/directory'
import { startsWith } from '../lib/util'
import { defaultTransformer } from '../lib/transformer'

// The binding tester is the actual comprehensive test suite for the directory
// layer. This mostly exists as a smoke test, and to exercise some of the API
// surface area that the binding tester won't reach.
withEachDb(db => describe('directory layer', () => {
  describe('high contention allocator', () => {
    const addToSet = async (keyBuf: Buffer, set: Set<number>) => {
      // The keys are actually numbers encoded with the tuple encoder
      const key = fdb.tuple.unpack(keyBuf)[0] as number

      // console.log(key)

      // Check the key is unique
      assert(!set.has(key))
      set.add(key)
    }

    const subspace = db.subspace.at('hca').withKeyEncoding(fdb.tuple)
    it('allocates unique values sequentially', async function() {
      const NUM = 100
      this.timeout(60000)

      const hca = new HighContentionAllocator(subspace)

      const keys = new Set<number>()
      for (let i = 0; i < NUM; i++) {
        const keyBuf = await db.doTn(txn => hca.allocate(txn))
        addToSet(keyBuf, keys)
      }
      assert.strictEqual(keys.size, NUM)
      // console.log(await hca._debugGetInternalState(db))
    })

    it('allocates unique values in concurrent transactions', async function() {
      const NUM = 100
      this.timeout(20000)

      const hca = new HighContentionAllocator(subspace)

      const keys = new Set<number>()
      const work = new Array(NUM).fill(null).map(() => (async () => {
        const keyBuf = await db.doTn(txn => hca.allocate(txn))
        addToSet(keyBuf, keys)
      })())
      await Promise.all(work)
      assert.strictEqual(keys.size, NUM)
      // console.log(await hca._debugGetInternalState(db))
    })
    
    it('allocates unique values in big transactions', async function() {
      const NUM_TXNS = 10
      const ALLOC_PER_TXN = 100
      this.timeout(6000000)
          
      const hca = new HighContentionAllocator(subspace)
  
      const keys = new Set<number>()
      const work = new Array(NUM_TXNS).fill(null).map(() => (async () => {
        const keyBufs = await db.doTn(async txn => {
          // This is really mean. I'm going to concurrently try to allocate
          // ALLOC_PER_TXN times inside here.
          const innerWork = new Array(ALLOC_PER_TXN).fill(null).map(() => db.doTn(txn => hca.allocate(txn)))
          return await Promise.all(innerWork)
        })

        for (const keyBuf of keyBufs) addToSet(keyBuf, keys)
      })())

      await Promise.all(work)
      assert.strictEqual(keys.size, NUM_TXNS * ALLOC_PER_TXN)
      // console.log(await hca._debugGetInternalState(db))
    })
  })

  describe('directories', () => {
    // I can actually reuse this directory layer because its stateless.
    const dl = new fdb.DirectoryLayer({
      contentSubspace: db.subspace.at('content'),
      nodeSubspace: db.subspace.at('\xfe'),
    })

    it('can make a directory', async () => {
      // This is a bit of a kitchen sink test. TODO: Pull all this apart into a
      // series of smaller tests.
      const dirA = await dl.create(db, ['some', 'dir'])
      await db.at(dirA).set('item', 'xxyy')
      assert.deepStrictEqual(dirA.getPath(), ['some', 'dir'])

      // Ok now can we read it back?
      const dirB = await dl.open(db, ['some', 'dir'])
      const valB = await db.at(dirB).get('item')
      assert.strictEqual(valB!.toString(), 'xxyy')

      // // Check the val is stored in the content subspace
      assert(startsWith(dirB.getSubspace().prefix, db.subspace.at('content').prefix))
      assert.deepStrictEqual(dirB.getPath(), ['some', 'dir']) // regression
      assert.deepStrictEqual(dirA.getSubspace().prefix, dirB.getSubspace().prefix)

      // The item shouldn't appear under 'some'.
      const dirParent = await dl.open(db, 'some')
      const valC = await db.at(dirParent).get('item')
      assert.equal(valC, null)

      // And we should see the subdirectory in list.
      assert.deepStrictEqual(await dirParent.listAll(db), ['dir'])

      // Check open('a').open('b') == open(['a', 'b']).
      const dirC = await dirParent.open(db, 'dir')
      assert.deepStrictEqual(dirC.getSubspace().prefix, dirA.getSubspace().prefix)
    })

    it('can move a directory', async () => {
      const dirA = await dl.create(db, 'a')
      await db.at(dirA).set('item', 'xxyy')

      const dirB = await dirA.moveTo(db, 'b')
      const val = await db.at(dirB).get('item')
      assert.strictEqual(val!.toString(), 'xxyy')
    })

    it('can remove a directory', async () => {
      const dirA = await dl.create(db, 'a')
      await db.at(dirA).set('item', 'val a')

      const dirB = await dl.create(db, 'b')
      await db.at(dirB).set('item', 'val b')

      // Remove dir A
      await dirA.remove(db)

      // We should only have 'val b' left in the content.
      const entries = await db.at(dl._contentSubspace.withKeyEncoding(defaultTransformer))
        .getRangeAllStartsWith(Buffer.alloc(0))
      assert.strictEqual(entries.length, 1)
      assert.strictEqual(entries[0][1].toString(), 'val b')
    })

    it('can make a partition', async () => {
      const part = await dl.create(db, 'part', 'partition')
      assert(part.isPartition())
      
      const dirA = await part.create(db, 'a')
      await db.at(dirA).set('item', 'val a')

      const dirB = await part.create(db, 'b')
      await db.at(dirB).set('item', 'val b')

      // Ok, the partition should contain both items. I'm quite uncomfortable
      // about the fact there's no nice way to do this using the current API.
      const contents = await db.at(part.content.withKeyEncoding(defaultTransformer))
        .getRangeAllStartsWith(Buffer.alloc(0))
    })

    it('refuses to open a directory with the wrong layer specified', async () => {
      const dirA = await dl.create(db, 'dir', 'layer a')
      await dl.open(db, 'dir', 'layer a') // <-- layer matches. should be ok.
      assert.rejects(dl.open(db, 'dir', 'layer b'), 'layer mismatch. Should throw')
      // Actually the other bindings allow this. I'm not sure it *should* be allowed, but there you go.
      // assert.rejects(dl.open(db, 'dir'), 'layer mismatch. Should throw')
    })

    it('can open a directory with high contention', async function() {
      const NUM = 100

      const work = new Array(NUM).fill(null).map(async (_, i) => {
        await dl.createOrOpen(db, `dir${i}`)
      })
      await Promise.all(work)
    })
  })
}))
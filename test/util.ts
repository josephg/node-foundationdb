import 'mocha'
import * as fdb from '../lib'

// We'll tuck everything behind this prefix and delete it all when the tests finish running.
export const prefix = '__test_data__/'

// export const prefixBuf = (key: Buffer) => Buffer.concat([Buffer.from(prefix), key])

// Using big endian numbers because they're lexographically sorted correctly.
export const bufToNum = (b: Buffer | null, def: number = 0) => b ? b.readInt32BE(0) : def
export const numToBuf = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeInt32BE(n, 0)
  return b
}

export const numXF = {
  pack: numToBuf,
  unpack: bufToNum
}

export const strXF = {
  pack(s: string) {return s},
  unpack(b: Buffer) {return b.toString('utf8')}
}

// Only testing with one API version for now.
// This should work with API versions 510, 520, 600, 610 and 620.
export const testApiVersion = 630

export const withEachDb = (fn: (db: fdb.Database) => void) => {
  fdb.setAPIVersion(testApiVersion)

  // These tests just use a single shared database cluster instance which is
  // reset between tests. It would be cleaner if we used beforeEach to close &
  // reopen the database but its probably fine like this.
  const db = fdb.open().at(prefix)

  // const s = defaultSubspace
  // const y = s.at(null, fdb.tuple)
  // const y2 = y.at(null, undefined, fdb.tuple)

  // const dy = db.at(null, fdb.tuple)
  // const dy2 = dy.at(null, undefined, fdb.tuple)

  after(() => {
    db.close()
    // fdb.stopNetworkSync()
  })

  // We need to do this both before and after tests run to clean up any mess
  // that a previously aborted test left behind. This is safe - it only clears
  // everything at the specified prefix. Its terrifying though.
  beforeEach(() => db.clearRangeStartsWith(''))
  afterEach(() => db.clearRangeStartsWith(''))

  describe('fdb', () => fn(db))

  // TODO: It would be nice to check that nothing was written outside of the prefix.
}

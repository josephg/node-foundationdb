import * as fdb from './native'
import Transaction, { RangeOptions, Watch } from './transaction'
import {Transformer, defaultTransformer} from './transformer'
import {NativeValue} from './native'
import {KeySelector} from './keySelector'
import Subspace, { root, GetSubspace, isGetSubspace } from './subspace'
import {eachOption} from './opts'
import {DatabaseOptions,
  TransactionOptions,
  databaseOptionData,
  MutationType,
} from './opts.g'

export type WatchWithValue<Value> = Watch & { value: Value | undefined }

export default class Database<KeyIn = NativeValue, KeyOut = Buffer, ValIn = NativeValue, ValOut = Buffer> {
  _db: fdb.NativeDatabase
  subspace: Subspace<KeyIn, KeyOut, ValIn, ValOut>

  constructor(db: fdb.NativeDatabase, subspace: Subspace<KeyIn, KeyOut, ValIn, ValOut>) {
    this._db = db
    this.subspace = subspace//new Subspace<KeyIn, KeyOut, ValIn, ValOut>(prefix, keyXf, valueXf)
  }

  setNativeOptions(opts: DatabaseOptions) {
    eachOption(databaseOptionData, opts, (code, val) => this._db.setOption(code, val))
  }

  close() {
    this._db.close()
  }

  // **** Scoping functions
  
  getRoot(): Database {
    return new Database(this._db, root)
  }

  getSubspace() { return this.subspace }
  getPrefix(): Buffer { return this.subspace.prefix }

  // The actual behaviour here has moved into subspace, but this method is kept for
  // convenience and backwards compatibility.
  /** Create a shallow reference to the database at a specified subspace */
  at<CKI, CKO, CVI, CVO>(hasSubspace: GetSubspace<CKI, CKO, CVI, CVO>): Database<CKI, CKO, CVI, CVO>
  /** Create a shallow reference to the database at the subspace of another database reference */
  // at<CKI = KeyIn, CKO = KeyOut, CVI = ValIn, CVO = ValOut>(prefix: KeyIn | null, keyXf?: Transformer<CKI, CKO>, valueXf?: Transformer<CVI, CVO>): Database<CKI, CKO, CVI, CVO>

  at(prefix: KeyIn | null): Database<KeyIn, KeyOut, ValIn, ValOut>;
  at<CKI, CKO>(prefix: KeyIn | null, keyXf: Transformer<CKI, CKO>): Database<CKI, CKO, ValIn, ValOut>;
  at<CVI, CVO>(prefix: KeyIn | null, keyXf: undefined, valueXf: Transformer<CVI, CVO>): Database<KeyIn, KeyOut, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix: KeyIn | null, keyXf: Transformer<CKI, CKO>, valueXf: Transformer<CVI, CVO>): Database<CKI, CKO, CVI, CVO>;

  at<CKI, CKO, CVI, CVO>(prefixOrSubspace: GetSubspace<CKI, CKO, CVI, CVO> | KeyIn | null, keyXf?: Transformer<CKI, CKO>, valueXf?: Transformer<CVI, CVO>): Database<CKI, CKO, CVI, CVO> {
    if (isGetSubspace(prefixOrSubspace)) return new Database(this._db, prefixOrSubspace.getSubspace())
    else return new Database(this._db, this.subspace.at(prefixOrSubspace, keyXf, valueXf))
  }

  withKeyEncoding<ChildKeyIn, ChildKeyOut>(keyXf: Transformer<ChildKeyIn, ChildKeyOut>): Database<ChildKeyIn, ChildKeyOut, ValIn, ValOut>
  withKeyEncoding<NativeValue, Buffer>(): Database<NativeValue, Buffer, ValIn, ValOut>
  withKeyEncoding<ChildKeyIn, ChildKeyOut>(keyXf: Transformer<any, any> = defaultTransformer): Database<ChildKeyIn, ChildKeyOut, ValIn, ValOut> {
    return new Database(this._db, this.subspace.at(null, keyXf))
  }
  
  withValueEncoding<ChildValIn, ChildValOut>(valXf: Transformer<ChildValIn, ChildValOut>): Database<KeyIn, KeyOut, ChildValIn, ChildValOut> {
    return new Database(this._db, this.subspace.at(null, undefined /* inherit */, valXf))
  }

  // This is the API you want to use for non-trivial transactions.
  async doTn<T>(body: (tn: Transaction<KeyIn, KeyOut, ValIn, ValOut>) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.rawCreateTransaction(opts)._exec(body)
  }
  // Alias for db.doTn.
  async doTransaction<T>(body: (tn: Transaction<KeyIn, KeyOut, ValIn, ValOut>) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    return this.doTn(body, opts)
  }

  doOneshot(body: (tn: Transaction<KeyIn, KeyOut, ValIn, ValOut>) => void, opts?: TransactionOptions): Promise<void> {
    // TODO: Could this be written better? It doesn't need a retry loop.
    return this.doTransaction(tn => {
      body(tn)
      return Promise.resolve()
    })
  }

  // TODO: setOption.

  // Infrequently used. You probably want to use doTransaction instead.
  rawCreateTransaction(opts?: TransactionOptions) {
    return new Transaction<KeyIn, KeyOut, ValIn, ValOut>(this._db.createTransaction(), false, this.subspace, opts)
  }

  get(key: KeyIn): Promise<ValOut | undefined> {
    return this.doTransaction(tn => tn.snapshot().get(key))
  }
  getKey(selector: KeyIn | KeySelector<KeyIn>): Promise<KeyOut | undefined> {
    return this.doTransaction(tn => tn.snapshot().getKey(selector))
  }
  getVersionstampPrefixedValue(key: KeyIn): Promise<{stamp: Buffer, value?: ValOut} | null> {
    return this.doTransaction(tn => tn.snapshot().getVersionstampPrefixedValue(key))
  }

  set(key: KeyIn, value: ValIn) {
    return this.doOneshot(tn => tn.set(key, value))
  }

  clear(key: KeyIn) {
    return this.doOneshot(tn => tn.clear(key))
  }

  clearRange(start?: KeyIn, end?: KeyIn) {
    return this.doOneshot(tn => tn.clearRange(start, end))
  }

  clearRangeStartsWith(prefix: KeyIn) {
    return this.doOneshot(tn => tn.clearRangeStartsWith(prefix))
  }

  getAndWatch(key: KeyIn): Promise<WatchWithValue<ValOut>> {
    return this.doTransaction(async tn => {
      const value = await tn.get(key)
      const watch = tn.watch(key) as WatchWithValue<ValOut>
      watch.value = value
      return watch
    })
  }

  // Not passing options through to the promise. The only option we support so
  // far is to pass through errors, but if we do that and the transaction
  // somehow conflicted, it would be impossible to avoid an uncaught promise
  // exception.
  setAndWatch(key: KeyIn, value: ValIn): Promise<Watch> {
    return this.doTransaction(async tn => {
      tn.set(key, value)
      return tn.watch(key)
    })
  }

  clearAndWatch(key: KeyIn): Promise<Watch> {
    return this.doTransaction(async tn => {
      tn.clear(key)
      return tn.watch(key)
    })
  }

  getRangeAll(
      start?: KeyIn | KeySelector<undefined | KeyIn>,
      end?: KeyIn | KeySelector<undefined | KeyIn>,
      opts?: RangeOptions) {
    return this.doTransaction(tn => tn.snapshot().getRangeAll(start, end, opts))
  }

  getRangeAllStartsWith(prefix: KeyIn | KeySelector<KeyIn>, opts?: RangeOptions) {
    return this.doTransaction(tn => tn.snapshot().getRangeAllStartsWith(prefix, opts))
  }

  getEstimatedRangeSizeBytes(start?: KeyIn, end?: KeyIn): Promise<number> {
    return this.doTransaction(tn => tn.getEstimatedRangeSizeBytes(start, end))
  }

  getRangeSplitPoints(start: KeyIn | undefined, end: KeyIn | undefined, chunkSize: number): Promise<KeyOut[]> {
    return this.doTransaction(tn => tn.getRangeSplitPoints(start, end, chunkSize))
  }

  // These functions all need to return their values because they're returning a child promise.
  atomicOpNative(op: MutationType, key: NativeValue, oper: NativeValue) {
    return this.doOneshot(tn => tn.atomicOpNative(op, key, oper))
  }
  atomicOp(op: MutationType, key: KeyIn, oper: ValIn) {
    return this.doOneshot(tn => tn.atomicOp(op, key, oper))
  }
  atomicOpKB(op: MutationType, key: KeyIn, oper: Buffer) {
    return this.doOneshot(tn => tn.atomicOpKB(op, key, oper))
  }
  add(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.Add, key, oper) }
  max(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.Max, key, oper) }
  min(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.Min, key, oper) }

  // Raw buffer variants are provided here to support fancy bit packing semantics.
  bitAnd(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.BitAnd, key, oper) }
  bitOr(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.BitOr, key, oper) }
  bitXor(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.BitXor, key, oper) }
  bitAndBuf(key: KeyIn, oper: Buffer) { return this.atomicOpKB(MutationType.BitAnd, key, oper) }
  bitOrBuf(key: KeyIn, oper: Buffer) { return this.atomicOpKB(MutationType.BitOr, key, oper) }
  bitXorBuf(key: KeyIn, oper: Buffer) { return this.atomicOpKB(MutationType.BitXor, key, oper) }

  // Performs lexicographic comparison of byte strings. Sets the value in the
  // database to the lexographical min / max of its current value and the
  // value supplied as a parameter. If the key does not exist in the database
  // this is the same as set().
  byteMin(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.ByteMin, key, oper) }
  byteMax(key: KeyIn, oper: ValIn) { return this.atomicOp(MutationType.ByteMax, key, oper) }

  // setVersionstampedKeyBuf(prefix: Buffer | undefined, suffix: Buffer | undefined, value: ValIn) {
  //   return this.doOneshot(tn => tn.setVersionstampedKeyBuf(prefix, suffix, value))
  // }
  setVersionstampedKey(key: KeyIn, value: ValIn, bakeAfterCommit?: boolean) {
    return this.doOneshot(tn => tn.setVersionstampedKey(key, value, bakeAfterCommit))
  }
  setVersionstampSuffixedKey(key: KeyIn, value: ValIn, suffix?: Buffer) {
    return this.doOneshot(tn => tn.setVersionstampSuffixedKey(key, value, suffix))
  }

  // setVersionstampedKeyPrefix(prefix: KeyIn, value: ValIn) {
  //   return this.setVersionstampedKey(prefix, undefined, value)
  // }

  setVersionstampedValue(key: KeyIn, value: ValIn, bakeAfterCommit: boolean = true) {
    return this.doOneshot(tn => tn.setVersionstampedValue(key, value, bakeAfterCommit))
  }

  // setVersionstampedValueBuf(key: KeyIn, oper: Buffer) { return this.atomicOpKB(MutationType.SetVersionstampedValue, key, oper) }
  setVersionstampPrefixedValue(key: KeyIn, value?: ValIn, prefix?: Buffer) {
    return this.doOneshot(tn => tn.setVersionstampPrefixedValue(key, value, prefix))
  }
}

import FDBError from './error'
import {
  Watch,
  NativeTransaction,
  Callback,
  NativeValue,
  Version,
} from './native'
import {
  strInc,
  strNext,
  asBuf
} from './util'
import keySelector, {KeySelector} from './keySelector'
import {eachOption} from './opts'
import {
  TransactionOptions,
  TransactionOptionCode,
  transactionOptionData,
  StreamingMode,
  MutationType
} from './opts.g'
import Database from './database'

import {
  Transformer,
} from './transformer'

import {
  UnboundStamp,
  packVersionstamp,
  packVersionstampPrefixSuffix
} from './versionstamp'
import Subspace, { GetSubspace } from './subspace'

const byteZero = Buffer.alloc(1)
byteZero.writeUInt8(0, 0)


export interface RangeOptionsBatch {
  // defaults to Iterator for batch mode, WantAll for getRangeAll.
  streamingMode?: undefined | StreamingMode,
  limit?: undefined | number,
  reverse?: undefined | boolean,
}

export interface RangeOptions extends RangeOptionsBatch {
  targetBytes?: undefined | number,
}

export type KVList<Key, Value> = {
  results: [Key, Value][], // [key, value] pair.
  more: boolean,
}

export {Watch}

export type WatchOptions = {
  throwAllErrors?: undefined | boolean
}

// Polyfill for node < 10.0 to make asyncIterators work (getRange / getRangeBatch).
if ((<any>Symbol).asyncIterator == null) (<any>Symbol).asyncIterator = Symbol.for("Symbol.asyncIterator")

const doNothing = () => {}

type BakeItem<T> = {item: T, transformer: Transformer<T, any>, code: Buffer | null}

// This scope object is shared by the family of transaction objects made with .scope().
interface TxnCtx {
  nextCode: number

  // If you call setVersionstampedKey / setVersionstampedValue, we pull out
  // the versionstamp from the txn and bake it back into the tuple (or
  // whatever) after the transaction commits.
  toBake: null | BakeItem<any>[]
}

/**
 * This class wraps a foundationdb transaction object. All interaction with the
 * data in a foundationdb database happens through a transaction. For more
 * detail about how to model your queries, see the [transaction chapter of the
 * FDB developer
 * guide](https://apple.github.io/foundationdb/developer-guide.html?#transaction-basics).
 *
 * You should never create transactions directly. Instead, open a database and
 * call `await db.doTn(async tn => {...})`.
 *
 * ```javascript
 * const db = fdb.open()
 * const val = await db.doTn(async tn => {
 *   // Use the transaction in this block. The transaction will be automatically
 *   // committed (and potentially retried) after this block returns.
 *   tn.set('favorite color', 'hotpink')
 *   return await tn.get('another key')
 * })
 * ```
 *
 * ---
 *
 * This class has 4 template parameters - which is kind of messy. They're used
 * to make the class typesafe in the face of key and value transformers. These
 * parameters should be automatically inferred, but sometimes you will need to
 * specify them explicitly. They are:
 *
 * @param KeyIn The type for keys passed by the user into functions (eg `get(k:
 * KeyIn)`). Defaults to string | Buffer. Change this by scoping the transaction
 * with a subspace with a key transformer. Eg
 * `txn.at(fdb.root.withKeyEncoding(fdb.tuple)).get([1, 2, 3])`.
 * @param KeyOut The type of keys returned by methods which return keys - like
 * `getKey(..) => Promise<KeyOut?>`. Unless you have a KV transformer, this will
 * be Buffer.
 * @param ValIn The type of values passed into transaction functions, like
 * `txn.set(key, val: ValIn)`. By default this is string | Buffer. Override this
 * by applying a value transformer to your subspace.
 * @param ValOut The type of database values returned by functions. Eg,
 * `txn.get(...) => Promise<ValOut | undefined>`. Defaults to Buffer, but if you
 * apply a value transformer this will change.
 */
export default class Transaction<KeyIn = NativeValue, KeyOut = Buffer, ValIn = NativeValue, ValOut = Buffer> {
  /** @internal */ _tn: NativeTransaction
  
  isSnapshot: boolean
  subspace: Subspace<KeyIn, KeyOut, ValIn, ValOut>

  // Copied out from scope for convenience, since these are so heavily used. Not
  // sure if this is a good idea.
  private _keyEncoding: Transformer<KeyIn, KeyOut>
  private _valueEncoding: Transformer<ValIn, ValOut>
  
  private _ctx: TxnCtx
  
  /**
   * NOTE: Do not call this directly. Instead transactions should be created
   * via db.doTn(...)
   * 
   * @internal
   */
  constructor(tn: NativeTransaction, snapshot: boolean,
      subspace: Subspace<KeyIn, KeyOut, ValIn, ValOut>,
      // keyEncoding: Transformer<KeyIn, KeyOut>, valueEncoding: Transformer<ValIn, ValOut>,
      opts?: TransactionOptions, ctx?: TxnCtx) {
    this._tn = tn

    this.isSnapshot = snapshot
    this.subspace = subspace
    this._keyEncoding = subspace._bakedKeyXf
    this._valueEncoding = subspace.valueXf

    // this._root = root || this
    if (opts) eachOption(transactionOptionData, opts, (code, val) => tn.setOption(code, val))

    this._ctx = ctx ? ctx : {
      nextCode: 0,
      toBake: null
    }
  }

  // Internal method to actually run a transaction retry loop. Do not call
  // this directly - instead use Database.doTn().

  /** @internal */
  async _exec<T>(body: (tn: Transaction<KeyIn, KeyOut, ValIn, ValOut>) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    // Logic described here:
    // https://apple.github.io/foundationdb/api-c.html#c.fdb_transaction_on_error
    do {
      try {
        const result = await body(this)

        const stampPromise = (this._ctx.toBake && this._ctx.toBake.length)
          ? this.getVersionstamp() : null

        await this.rawCommit()

        if (stampPromise) {
          const stamp = await stampPromise.promise

          this._ctx.toBake!.forEach(({item, transformer, code}) => (
            transformer.bakeVersionstamp!(item, stamp, code))
          )
        }
        return result // Ok, success.
      } catch (err) {
        // See if we can retry the transaction
        if (err instanceof FDBError) {
          await this.rawOnError(err.code) // If this throws, punt error to caller.
          // If that passed, loop.
        } else throw err
      }

      // Reset our local state that will have been filled in by calling the body.
      this._ctx.nextCode = 0
      if (this._ctx.toBake) this._ctx.toBake.length = 0
    } while (true)
  }

  /**
   * Set options on the transaction object. These options can have a variety of
   * effects - see TransactionOptionCode for details. For options which are
   * persistent on the transaction, its recommended to set the option when the
   * transaction is constructed.
   *
   * Note that options are shared between a transaction object and any aliases
   * of the transaction object (eg in other scopes or from `txn.snapshot()`).
   */
  setOption(opt: TransactionOptionCode, value?: number | string | Buffer) {
    // TODO: Check type of passed option is valid.
    this._tn.setOption(opt, (value == null) ? null : value)
  }

  /**
   * Returns a shallow copy of the transaction object which does snapshot reads.
   */
  snapshot(): Transaction<KeyIn, KeyOut, ValIn, ValOut> {
    return new Transaction(this._tn, true, this.subspace, undefined, this._ctx)
  }

  /**
   * Create a shallow copy of the transaction in the specified subspace (or database, transaction, or directory).
  */
  at<CKI, CKO, CVI, CVO>(hasSubspace: GetSubspace<CKI, CKO, CVI, CVO>): Transaction<CKI, CKO, CVI, CVO> {
    return new Transaction(this._tn, this.isSnapshot, hasSubspace.getSubspace(), undefined, this._ctx)
  }

  /** @deprecated - use transaction.at(db) instead. */
  scopedTo<CKI, CKO, CVI, CVO>(db: Database<CKI, CKO, CVI, CVO>): Transaction<CKI, CKO, CVI, CVO> {
    return this.at(db)
  }

  /** Get the current subspace */
  getSubspace() { return this.subspace }

  // You probably don't want to call any of these functions directly. Instead call db.transact(async tn => {...}).

  /**
   * This uses the raw API to commit a transaction. 99% of users shouldn't touch this, and should instead use `db.doTn(async tn => {...})`, which will automatically commit the transaction and retry if necessary.
   */
  rawCommit(): Promise<void>
  /** @deprecated - Use promises API instead. */
  rawCommit(cb: Callback<void>): void
  rawCommit(cb?: Callback<void>) {
    return cb
      ? this._tn.commit(cb)
      : this._tn.commit()
  }

  rawReset() { this._tn.reset() }
  rawCancel() { this._tn.cancel() }

  rawOnError(code: number): Promise<void>
  /** @deprecated - Use promises API instead. */
  rawOnError(code: number, cb: Callback<void>): void
  rawOnError(code: number, cb?: Callback<void>) {
    return cb
      ? this._tn.onError(code, cb)
      : this._tn.onError(code)
  }

  /**
   * Get the value for the specified key in the database.
   *
   * @returns the value for the specified key, or `undefined` if the key does
   * not exist in the database.
   */
  get(key: KeyIn): Promise<ValOut | undefined>
  /** @deprecated - Use promises API instead. */
  get(key: KeyIn, cb: Callback<ValOut | undefined>): void
  get(key: KeyIn, cb?: Callback<ValOut | undefined>) {
    const keyBuf = this._keyEncoding.pack(key)
    return cb
      ? this._tn.get(keyBuf, this.isSnapshot, (err, val) => {
        cb(err, val == null ? undefined : this._valueEncoding.unpack(val))
      })
      : this._tn.get(keyBuf, this.isSnapshot)
        .then(val => val == null ? undefined : this._valueEncoding.unpack(val))
  }

  /** Checks if the key exists in the database. This is just a shorthand for
   * tn.get() !== undefined.
   */
  exists(key: KeyIn): Promise<boolean> {
    const keyBuf = this._keyEncoding.pack(key)
    return this._tn.get(keyBuf, this.isSnapshot).then(val => val != undefined)
  }

  /**
   * Find and return the first key which matches the specified key selector
   * inside the given subspace. Returns undefined if no key matching the
   * selector falls inside the current subspace.
   *
   * If you pass a key instead of a selector, this method will find the first
   * key >= the specified key. Aka `getKey(someKey)` is the equivalent of
   * `getKey(keySelector.firstGreaterOrEqual(somekey))`.
   *
   * Note that this method is a little funky in the root subspace:
   *
   * - We cannot differentiate between "no smaller key found" and "found the
   *   empty key ('')". To make the API more consistent, we assume you aren't
   *   using the empty key in your dataset.
   * - If your key selector looks forward in the dataset, this method may find
   *   and return keys in the system portion (starting with '\xff').
   */
  getKey(_sel: KeySelector<KeyIn> | KeyIn): Promise<KeyOut | undefined> {
    const sel = keySelector.from(_sel)
    return this._tn.getKey(this._keyEncoding.pack(sel.key), sel.orEqual, sel.offset, this.isSnapshot)
      .then(key => (
        (key.length === 0 || !this.subspace.contains(key))
          ? undefined
          : this._keyEncoding.unpack(key)
      ))
  }

  /** Set the specified key/value pair in the database */
  set(key: KeyIn, val: ValIn) {
    this._tn.set(this._keyEncoding.pack(key), this._valueEncoding.pack(val))
  }

  /** Remove the value for the specified key */
  clear(key: KeyIn) {
    const pack = this._keyEncoding.pack(key)
    this._tn.clear(pack)
  }

  /** Alias for `tn.clear()` to match semantics of javascripts Map/Set/etc classes */
  delete(key: KeyIn) {
    return this.clear(key)
  }

  // This just destructively edits the result in-place.
  private _encodeRangeResult(r: [Buffer, Buffer][]): [KeyOut, ValOut][] {
    // This is slightly faster but I have to throw away the TS checks in the process. :/
    for (let i = 0; i < r.length; i++) {
      ;(r as any)[i][0] = this._keyEncoding.unpack(r[i][0])
      ;(r as any)[i][1] = this._valueEncoding.unpack(r[i][1])
    }
    return r as any as [KeyOut, ValOut][]
  }

  getRangeNative(start: KeySelector<NativeValue>,
      end: KeySelector<NativeValue> | null,  // If not specified, start is used as a prefix.
      limit: number, targetBytes: number, streamingMode: StreamingMode,
      iter: number, reverse: boolean): Promise<KVList<Buffer, Buffer>> {
    const _end = end != null ? end : keySelector.firstGreaterOrEqual(strInc(start.key))
    return this._tn.getRange(
      start.key, start.orEqual, start.offset,
      _end.key, _end.orEqual, _end.offset,
      limit, targetBytes, streamingMode,
      iter, this.isSnapshot, reverse)
  }

  getRangeRaw(start: KeySelector<KeyIn>, end: KeySelector<KeyIn> | null,
      limit: number, targetBytes: number, streamingMode: StreamingMode,
      iter: number, reverse: boolean): Promise<KVList<KeyOut, ValOut>> {
    return this.getRangeNative(
      keySelector.toNative(start, this._keyEncoding),
      end != null ? keySelector.toNative(end, this._keyEncoding) : null,
      limit, targetBytes, streamingMode, iter, reverse)
    .then(r => ({more: r.more, results: this._encodeRangeResult(r.results)}))
  }

  getEstimatedRangeSizeBytes(start: KeyIn, end: KeyIn): Promise<number> {
    return this._tn.getEstimatedRangeSizeBytes(
      this._keyEncoding.pack(start),
      this._keyEncoding.pack(end)
    )
  }

  getRangeSplitPoints(start: KeyIn, end: KeyIn, chunkSize: number): Promise<KeyOut[]> {
    return this._tn.getRangeSplitPoints(
      this._keyEncoding.pack(start),
      this._keyEncoding.pack(end),
      chunkSize
    ).then(results => (
      results.map(r => this._keyEncoding.unpack(r))
    ))
  }

  /**
   * This method is functionally the same as *getRange*, but values are returned
   * in the batches they're delivered in from the database. This method is
   * present because it may be marginally faster than `getRange`.
   * 
   * Example:
   * 
   * ```
   * for await (const batch of tn.getRangeBatch(0, 1000)) {
   *   for (let k = 0; k < batch.length; k++) {
   *     const [key, val] = batch[k]
   *     // ...
   *   }
   * }
   * ```
   * 
   * @see Transaction.getRange
   */
  async *getRangeBatch(
      _start: KeyIn | KeySelector<KeyIn>, // Consider also supporting string / buffers for these.
      _end?: KeyIn | KeySelector<KeyIn>, // If not specified, start is used as a prefix.
      opts: RangeOptions = {}) {

    // This is a bit of a dog's breakfast. We're trying to handle a lot of different cases here:
    // - The start and end parameters can be specified as keys or as selectors
    // - The end parameter can be missing / null, and if it is we want to "do the right thing" here
    //   - Which normally means searching between [start, strInc(start)]
    //   - But with tuple encoding this means between [start + '\x00', start + '\xff']

    let start: KeySelector<string | Buffer>, end: KeySelector<string | Buffer>
    const startSelEnc = keySelector.from(_start)
    
    if (_end == null) {
      const range = this.subspace.packRange(startSelEnc.key)
      start = keySelector(range.begin, startSelEnc.orEqual, startSelEnc.offset)
      end = keySelector.firstGreaterOrEqual(range.end)
    } else {
      start = keySelector.toNative(startSelEnc, this._keyEncoding)
      end = keySelector.toNative(keySelector.from(_end), this._keyEncoding)
    }

    let limit = opts.limit || 0
    const streamingMode = opts.streamingMode == null ? StreamingMode.Iterator : opts.streamingMode

    let iter = 0
    while (1) {
      const {results, more} = await this.getRangeNative(start, end,
        limit, 0, streamingMode, ++iter, opts.reverse || false)

      if (results.length) {
        if (!opts.reverse) start = keySelector.firstGreaterThan(results[results.length-1][0])
        else end = keySelector.firstGreaterOrEqual(results[results.length-1][0])
      }

      // This destructively consumes results.
      yield this._encodeRangeResult(results)
      if (!more) break

      if (limit) {
        limit -= results.length
        if (limit <= 0) break
      }
    }
  }

  // TODO: getRangeBatchStartsWith

  /**
   * Get all key value pairs within the specified range. This method returns an
   * async generator, which can be iterated over in a `for await(...)` loop like
   * this:
   *
   * ```
   * for await (const [key, value] of tn.getRange('a', 'z')) {
   *  // ...
   * }
   * ```
   *
   * The values will be streamed from the database as they are read.
   *
   * Key value pairs will be yielded in the order they are present in the
   * database - from lowest to highest key. (Or the reverse order if
   * `reverse:true` is set in options).
   *
   * Note that transactions are [designed to be short
   * lived](https://apple.github.io/foundationdb/developer-guide.html?#long-running-transactions),
   * and will error if the read operation takes more than 5 seconds.
   *
   * The end of the range is optional. If missing, this method will use the
   * first parameter as a prefix and fetch all key value pairs starting with
   * that key.
   *
   * The start or the end can be specified using KeySelectors instead of raw
   * keys in order to specify offsets and such.
   *
   * getRange also takes an optional extra options object parameter. Valid
   * options are:
   *
   * - **limit:** (number) Maximum number of items returned by the call to
   *   getRange
   * - **reverse:** (boolean) Flag to reverse the iteration, and instead search
   *   from `end` to `start`. Key value pairs will be returned from highest key
   *   to lowest key.
   * - **streamingMode:** (enum StreamingMode) *(rarely used)* The policy for
   *   how eager FDB should be about prefetching data. See enum StreamingMode in
   *   opts.
   */
  async *getRange(
      start: KeyIn | KeySelector<KeyIn>, // Consider also supporting string / buffers for these.
      end?: KeyIn | KeySelector<KeyIn>,
      opts?: RangeOptions) {
    for await (const batch of this.getRangeBatch(start, end, opts)) {
      for (const pair of batch) yield pair
    }
  }

  // TODO: getRangeStartsWtih

  /**
   * Same as getRange, but prefetches and returns all values in an array rather
   * than streaming the values over the wire. This is often more convenient, and
   * makes sense when dealing with a small range.
   * 
   * @see Transaction.getRange
   *
   * @returns array of [key, value] pairs
   */
  async getRangeAll(
      start: KeyIn | KeySelector<KeyIn>,
      end?: KeyIn | KeySelector<KeyIn>, // if undefined, start is used as a prefix.
      opts: RangeOptions = {}) {
    const childOpts: RangeOptions = {...opts}
    if (childOpts.streamingMode == null) childOpts.streamingMode = StreamingMode.WantAll

    const result: [KeyOut, ValOut][] = []
    for await (const batch of this.getRangeBatch(start, end, childOpts)) {
      result.push.apply(result, batch)
    }
    return result
  }

  getRangeAllStartsWith(prefix: KeyIn | KeySelector<KeyIn>, opts?: RangeOptions) {
    return this.getRangeAll(prefix, undefined, opts)
  }
  
  /**
   * Removes all key value pairs from the database in between start and end.
   *
   * End parameter is optional. If not specified, this removes all keys with
   * *start* as a prefix.
   */
  clearRange(_start: KeyIn, _end?: KeyIn) {
    let start: NativeValue, end: NativeValue
    // const _start = this._keyEncoding.pack(start)

    if (_end == null) {
      const range = this.subspace.packRange(_start)
      start = range.begin
      end = range.end
    } else {
      start = this._keyEncoding.pack(_start)
      end = this._keyEncoding.pack(_end)
    }
    // const _end = end == null ? strInc(_start) : this._keyEncoding.pack(end)
    this._tn.clearRange(start, end)
  }

  /** An alias for unary clearRange */
  clearRangeStartsWith(prefix: KeyIn) {
    this.clearRange(prefix)
  }

  watch(key: KeyIn, opts?: WatchOptions): Watch {
    const throwAll = opts && opts.throwAllErrors
    const watch = this._tn.watch(this._keyEncoding.pack(key), !throwAll)
    // Suppress the global unhandledRejection handler when a watch errors
    watch.promise.catch(doNothing)
    return watch
  }

  addReadConflictRange(start: KeyIn, end: KeyIn) {
    this._tn.addReadConflictRange(this._keyEncoding.pack(start), this._keyEncoding.pack(end))
  }
  addReadConflictKey(key: KeyIn) {
    const keyBuf = this._keyEncoding.pack(key)
    this._tn.addReadConflictRange(keyBuf, strNext(keyBuf))
  }

  addWriteConflictRange(start: KeyIn, end: KeyIn) {
    this._tn.addWriteConflictRange(this._keyEncoding.pack(start), this._keyEncoding.pack(end))
  }
  addWriteConflictKey(key: KeyIn) {
    const keyBuf = this._keyEncoding.pack(key)
    this._tn.addWriteConflictRange(keyBuf, strNext(keyBuf))
  }

  // version must be 8 bytes
  setReadVersion(v: Version) { this._tn.setReadVersion(v) }

  /** Get the database version used to perform reads in this transaction. */
  getReadVersion(): Promise<Version>
  /** @deprecated - Use promises API instead. */
  getReadVersion(cb: Callback<Version>): void
  getReadVersion(cb?: Callback<Version>) {
    return cb ? this._tn.getReadVersion(cb) : this._tn.getReadVersion()
  }

  getCommittedVersion() { return this._tn.getCommittedVersion() }

  // Note: This promise can't be directly returned via the return value of a
  // transaction.
  getVersionstamp(): {promise: Promise<Buffer>}
  /** @deprecated - Use promises API instead. */
  getVersionstamp(cb: Callback<Buffer>): void
  getVersionstamp(cb?: Callback<Buffer>) {
    if (cb) return this._tn.getVersionstamp(cb)
    else {
      // This one is surprisingly tricky:
      //
      // - If we return the promise as normal, you'll deadlock if you try to
      //   return it via your async tn function (since JS automatically
      //   flatmaps promises)
      // - Also if the tn conflicts, this promise will also generate an error.
      //   By default node will crash your program when it sees this error.
      //   We'll allow the error naturally, but suppress node's default
      //   response by adding an empty catch function
      const promise = this._tn.getVersionstamp()
      promise.catch(doNothing)
      return {promise}
    }
  }

  getAddressesForKey(key: KeyIn): string[] {
    return this._tn.getAddressesForKey(this._keyEncoding.pack(key))
  }

  // **** Atomic operations

  atomicOpNative(opType: MutationType, key: NativeValue, oper: NativeValue) {
    this._tn.atomicOp(opType, key, oper)
  }
  atomicOpKB(opType: MutationType, key: KeyIn, oper: Buffer) {
    this._tn.atomicOp(opType, this._keyEncoding.pack(key), oper)
  }
  atomicOp(opType: MutationType, key: KeyIn, oper: ValIn) {
    this._tn.atomicOp(opType, this._keyEncoding.pack(key), this._valueEncoding.pack(oper))
  }

  /**
   * Does little-endian addition on encoded values. Value transformer should encode to some
   * little endian type.
   */
  add(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.Add, key, oper) }
  max(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.Max, key, oper) }
  min(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.Min, key, oper) }

  // Raw buffer variants are provided here to support fancy bit packing semantics.
  bitAnd(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.BitAnd, key, oper) }
  bitOr(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.BitOr, key, oper) }
  bitXor(key: KeyIn, oper: ValIn) { this.atomicOp(MutationType.BitXor, key, oper) }
  bitAndBuf(key: KeyIn, oper: Buffer) { this.atomicOpKB(MutationType.BitAnd, key, oper) }
  bitOrBuf(key: KeyIn, oper: Buffer) { this.atomicOpKB(MutationType.BitOr, key, oper) }
  bitXorBuf(key: KeyIn, oper: Buffer) { this.atomicOpKB(MutationType.BitXor, key, oper) }

  /*
   * Performs lexicographic comparison of byte strings. Sets the value in the
   * database to the lexographical min of its current value and the value
   * supplied as a parameter. If the key does not exist in the database this is
   * the same as set().
   */
  byteMin(key: KeyIn, val: ValIn) { this.atomicOp(MutationType.ByteMin, key, val) }
  /*
   * Performs lexicographic comparison of byte strings. Sets the value in the
   * database to the lexographical max of its current value and the value
   * supplied as a parameter. If the key does not exist in the database this is
   * the same as set().
   */
  byteMax(key: KeyIn, val: ValIn) { this.atomicOp(MutationType.ByteMax, key, val) }


  // **** Version stamp stuff

  getNextTransactionID() { return this._ctx.nextCode++ }

  private _bakeCode(into: UnboundStamp) {
    if (this.isSnapshot) throw new Error('Cannot use this method in a snapshot transaction')
    if (into.codePos != null) {
      // We edit the buffer in-place but leave the codepos as is so if the txn
      // retries it'll overwrite the code.
      const id = this.getNextTransactionID()
      if (id > 0xffff) throw new Error('Cannot use more than 65536 unique versionstamps in a single transaction. Either split your writes into multiple transactions or add explicit codes to your unbound versionstamps')
      into.data.writeInt16BE(id, into.codePos)
      return into.data.slice(into.codePos, into.codePos+2)
    }
    return null
  }

  setVersionstampedKeyRaw(keyBytes: Buffer, value: ValIn) {
    this.atomicOpNative(MutationType.SetVersionstampedKey, keyBytes, this._valueEncoding.pack(value))
  }

  // This sets the key [prefix, 10 bytes versionstamp, suffix] to value.
  setVersionstampedKeyBuf(prefix: Buffer | undefined, suffix: Buffer | undefined, value: ValIn) {
    const key = packVersionstampPrefixSuffix(prefix, suffix, true)
    // console.log('key', key)
    this.atomicOpNative(MutationType.SetVersionstampedKey, key, this._valueEncoding.pack(value))
  }

  private _addBakeItem<T>(item: T, transformer: Transformer<T, any>, code: Buffer | null) {
    if (transformer.bakeVersionstamp) {
      const scope = this._ctx
      if (scope.toBake == null) scope.toBake = []
      scope.toBake.push({item, transformer, code})
    }
  }

  // TODO: These method names are a bit confusing.
  // 
  // The short version is, if you're using the tuple type with an unbound
  // versionstamp, use setVersionstampedKey. Otherwise if you just want your
  // key to be baked out with a versionstamp after it, use
  // setVersionstampSuffixedKey.
  setVersionstampedKey(key: KeyIn, value: ValIn, bakeAfterCommit: boolean = true) {
    if (!this._keyEncoding.packUnboundVersionstamp) {
      throw TypeError('Key encoding does not support unbound versionstamps. Use setVersionstampPrefixedValue instead')
    }

    const pack = this._keyEncoding.packUnboundVersionstamp(key)
    const code = this._bakeCode(pack)
    this.setVersionstampedKeyRaw(packVersionstamp(pack, true), value)

    if (bakeAfterCommit) this._addBakeItem(key, this._keyEncoding, code)
  }

  setVersionstampSuffixedKey(key: KeyIn, value: ValIn, suffix?: Buffer) {
    const prefix = asBuf(this._keyEncoding.pack(key))
    this.setVersionstampedKeyBuf(prefix, suffix, value)
  }

  // Ok now versionstamped values

  setVersionstampedValueRaw(key: KeyIn, value: Buffer) {
    this.atomicOpKB(MutationType.SetVersionstampedValue, key, value)
  }

  setVersionstampedValue(key: KeyIn, value: ValIn, bakeAfterCommit: boolean = true) {
    // This is super similar to setVersionstampedKey. I wish I could reuse the code.
    if (!this._valueEncoding.packUnboundVersionstamp) {
      throw TypeError('Value encoding does not support unbound versionstamps. Use setVersionstampPrefixedValue instead')
    }

    const pack = this._valueEncoding.packUnboundVersionstamp(value)
    const code = this._bakeCode(pack)
    this.setVersionstampedValueRaw(key, packVersionstamp(pack, false))

    if (bakeAfterCommit) this._addBakeItem(value, this._valueEncoding, code)
  }

  /**
   * Set key = [10 byte versionstamp, value in bytes]. This function leans on
   * the value transformer to pack & unpack versionstamps. An extra value
   * prefix is only supported on API version 520+.
   */
  setVersionstampPrefixedValue(key: KeyIn, value?: ValIn, prefix?: Buffer) {
    const valBuf = value !== undefined ? asBuf(this._valueEncoding.pack(value)) : undefined
    const val = packVersionstampPrefixSuffix(prefix, valBuf, false)
    this.atomicOpKB(MutationType.SetVersionstampedValue, key, val)
  }

  /**
   * Helper to get the specified key and split out the stamp and value pair.
   * This requires that the stamp is at offset 0 (the start) of the value.
   * This is designed to work with setVersionstampPrefixedValue. If you're
   * using setVersionstampedValue with tuples, just call get().
   */
  async getVersionstampPrefixedValue(key: KeyIn): Promise<{stamp: Buffer, value?: ValOut} | null> {
    const val = await this._tn.get(this._keyEncoding.pack(key), this.isSnapshot)

    if (val == null) {
      return null;
    }

    return val.length <= 10
      ? {
        stamp: val
      }
      : {
        stamp: val.slice(0, 10),

        // So this is a bit opinionated - if you call
        // setVersionstampPrefixedValue with no value, the db will just have
        // the 10 byte versionstamp. So when you get here, we have no bytes
        // for the decoder and that can cause issues. We'll just return null
        // in that case - but, yeah, controversial. You might want some other
        // encoding or something. File an issue if this causes you grief.
        value: this._valueEncoding.unpack(val.slice(10))
      }
  }

  getApproximateSize() {
    return this._tn.getApproximateSize()
  }

  // This packs the value by prefixing the version stamp to the
  // valueEncoding's packed version of the value.
  // This is intended for use with getPackedVersionstampedValue.
  //
  // If your key transformer sometimes returns an unbound value for this key
  // (eg using tuples), just call set(key, value).
  // setVersionstampedValueBuf(key: KeyIn, value: Buffer, pos: number = 0) {
  //   // const valPack = packVersionstampedValue(asBuf(this._valueEncoding.pack(value)), pos)
  //   const valPack = packVersionstampRaw(value, pos, true)
  //   this.atomicOpKB(MutationType.SetVersionstampedValue, key, valPack)
  // }
}

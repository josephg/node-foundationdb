import Transaction from "./transaction";
import { Database, tuple, TupleItem, util } from ".";
import { Transformer, defaultTransformer } from "./transformer";
import { TransactionOptionCode } from "./opts.g";
import { concat2, startsWith, strInc, asBuf } from "./util";
import Subspace, { root } from "./subspace";
import { inspect } from "util";
import { NativeValue, NativeTransaction } from "./native";
// import FDBError from './error'

export class DirectoryError extends Error {
  constructor(description: string) {
    super(description)

    Object.setPrototypeOf(this, DirectoryError.prototype);
    // Error.captureStackTrace(this, this.constructor);
  }
}

// The directory layer provides a way to use key subspaces without needing to
// make increasingly longer key prefixes over time.

// Every application should put its data inside a directory.

// For more information see the developer guide:
// https://apple.github.io/foundationdb/developer-guide.html#directories

// Or this great write-up of how and why the HCA allocator works:
// https://activesphere.com/blog/2018/08/05/high-contention-allocator

type DbAny = Database<any, any, any, any>
type TxnAny = Transaction<any, any, any, any>
type SubspaceAny = Subspace<any, any, any, any>

type DbOrTxn<KeyIn, KeyOut, ValIn, ValOut> = Database<KeyIn, KeyOut, ValIn, ValOut> | Transaction<KeyIn, KeyOut, ValIn, ValOut>

type TupleIn = undefined | TupleItem | TupleItem[]
/** Node subspaces have tuple keys like [SUBDIRS, (bytes)] and [b'layer']. */
type NodeSubspace = Subspace<TupleIn, TupleItem[], NativeValue, Buffer>

const BUF_EMPTY = Buffer.alloc(0)

const arrStartsWith = <T>(arr: T[], prefix: T[]): boolean => {
  if (arr.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (arr[i] !== prefix[i]) return false
  }
  return true
}
const arrEq = <T>(x: T[], y: T[]): boolean => {
  if (x.length !== y.length) return false
  for (let i = 0; i < y.length; i++) {
    if (x[i] !== y[i]) return false
  }
  return true
}

// Wrapper for functions which take a database or a transaction.
const doTxn = <KeyIn, KeyOut, ValIn, ValOut, T>(
  dbOrTxn: Database<KeyIn, KeyOut, ValIn, ValOut> | Transaction<KeyIn, KeyOut, ValIn, ValOut>,
  body: (tn: Transaction<KeyIn, KeyOut, ValIn, ValOut>) => Promise<T>): Promise<T> => {
  
  return (dbOrTxn instanceof Database) ? dbOrTxn.doTn(body) : body(dbOrTxn)
}

// Technically the counter encoding supports 64 bit numbers. We'll only support
// numbers in the JS safe range (up to 2^53) but thats honestly gonna be fine.
// Consider exporting this via transformer.
//
// Only exported for testing.
export const counterEncoding: Transformer<number, number> = {
  pack(val) {
    const b = Buffer.alloc(8)
    if (!Number.isSafeInteger(val)) throw new DirectoryError('Invalid counter (number outside JS safe range)')

    // If we're using node 12+ everywhere we could just call this:
    //b.writeBigUInt64LE(BigInt(val))

    const lowBits = (val & 0xffffffff) >>> 0
    const highBits = ((val - lowBits) / 0x100000000) >>> 0
      
    b.writeUInt32LE(lowBits, 0) // low
    b.writeUInt32LE(highBits, 4) // high
    return b
  },
  unpack: (buf) => {
    const val = buf.readUInt32LE(0) + (buf.readUInt32LE(4) * 0x100000000)
    if (!Number.isSafeInteger(val)) throw new DirectoryError('Invalid counter (number outside JS safe range)')
    return val
  },
}

const voidEncoding: Transformer<void, void> = {
  pack(val) { return BUF_EMPTY },
  unpack(buf) { return null }
}

type Version = [number, number, number]
// I really wish I could just use python's pack here. This is <III written out
// in long form. (And counterEncoding above is <q). I could use a module like
// https://www.npmjs.com/package/python-struct , but it feels like overkill for
// this.
const versionEncoder: Transformer<Version, Version> = {
  pack(ver) {
    const buf = Buffer.alloc(12)
    buf.writeUInt32LE(ver[0], 0)
    buf.writeUInt32LE(ver[1], 4)
    buf.writeUInt32LE(ver[2], 8)
    return buf
  },
  unpack(buf) {
    return [buf.readUInt32LE(0), buf.readUInt32LE(4), buf.readUInt32LE(8)]
  }
}


const window_size = (start: number) => (
  // From the python bindings:
  //   Larger window sizes are better for high contention, smaller sizes for
  //   keeping the keys small.  But if there are many allocations, the keys
  //   can't be too small.  So start small and scale up.  We don't want this
  //   to ever get *too* big because we have to store about window_size/2
  //   recent items.
  start < 255 ? 64
    : (start < 65535) ? 1024
    : 8192
)

const hcaLock = new WeakMap<NativeTransaction, Promise<void>>()

async function synchronized(tn: TxnAny, block: () => Promise<void>) {
  // Nodejs is single threaded and the FDB transaction system protects us
  // against multiple concurrent transactions allocating using the HCA.
  // Unfortunately, we still need to protect against the case where a single
  // transaction initiates multiple concurrent calls into HCA (using
  // Promise.all / race or similar).

  // We're using tn._tn because that references the underlying fdb transaction
  // object, shared between all scoped versions of the transaction.
  const ref = tn._tn

  const lock = hcaLock.get(ref)

  const nextStep = lock != null
    ? lock.then(block) // Run next
    : block() // Run now

  hcaLock.set(ref, nextStep)

  await nextStep

  // We're using a WeakMap so the GC *should* take care of this, but ...
  if (hcaLock.get(ref) === nextStep) hcaLock.delete(ref)
}

// Exported for testing.
export class HighContentionAllocator {
  // db: Database<any, any, any, any>
  counters: Subspace<TupleIn, TupleItem[], number, number>
  recent: Subspace<TupleIn, TupleItem[], void, void> // The value here will always be BUF_EMPTY.

  constructor(subspace: SubspaceAny) {
    // this.db = db.withKeyEncoding(tuple) //.at([counters, recent])
    this.counters = subspace.withKeyEncoding(tuple).at(0).withValueEncoding(counterEncoding)
    this.recent = subspace.withKeyEncoding(tuple).at(1).withValueEncoding(voidEncoding)
  }

  // For debugging.
  async _debugGetInternalState(dbOrTxn: DbAny | TxnAny) {
    return await doTxn(dbOrTxn, async txn => ({
      counters: (await txn.at(this.counters).getRangeAllStartsWith(undefined))
        .map(([[start], count]) => ({start, count}))[0],
      recent: (await txn.at(this.recent).getRangeAllStartsWith(undefined))
        .map(([[k]]) => k)
    }))
  }

  async allocate(_tn: TxnAny): Promise<Buffer> {
    // Counters stores the number of allocations in each window.
    const counters = _tn.at(this.counters)
    // Recent marks all allocations inside the current window.
    const recent = _tn.at(this.recent)

    // This logic is a direct port of the equivalent code in the ruby bindings.
    // const snap = tn.snapshot()
    while (true) {
      let [[start], count] = (await counters.snapshot().getRangeAllStartsWith(undefined, {limit: 1, reverse: true}))[0] as [[number], number]
        || [[0],0]

      let window_advanced = false
      let window

      // 1. Consider growing the window if the count has changed the window size.
      while (true) {
        // TODO: I think we can narrow this synchronized block to the
        // window_advanced logic, but I'm not game to change it before we have
        // tests that can spot the bug. Maybe the binding tester can assess this
        // change.
        await synchronized(_tn, async () => {
          // This logic makes more sense at the bottom of the enclosing while
          // block, but its here so we don't need to do two synchronized blocks.
          if (window_advanced) {
            counters.clearRange([], start)
            recent.setOption(TransactionOptionCode.NextWriteNoWriteConflictRange)
            recent.clearRange([], start)
          }

          counters.add(start, 1)
          count = (await counters.snapshot().get(start))!
          // console.log('incremented count to', count)
        })

        window = window_size(start)
        // Almost all the time, the window is a reasonable size and we break here.
        if (count * 2 < window) break

        // But if we've run out of room in the window (fill >= 50%), discard the
        // window and increment the window start by the window size.
        start += window
        window_advanced = true
      }

      // 2. Look for a candidate name we can allocate
      while (true) {
        let candidate = start + Math.floor(Math.random() * window)

        let latest_counter: any[]
        let candidate_in_use: boolean

        // Again, not sure if this synchronized block is needed.
        await synchronized(_tn, async () => {
          latest_counter = (await counters.snapshot().getRangeAllStartsWith(undefined, {limit: 1, reverse: true})).map(([k]) => k)
          candidate_in_use = await recent.exists(candidate)

          // Take ownership of the candidate key, but there's no need to retry
          // the whole txn if another allocation call has claimed it.
          recent.setOption(TransactionOptionCode.NextWriteNoWriteConflictRange)
          recent.set(candidate)
        })

        // If the window size changes concurrently while we're allocating, restart the whole process.
        if (latest_counter!.length > 0 && latest_counter![0] > start) break

        if (candidate_in_use! === false) {
          // Hooray! The candidate key isn't used by anyone else. Tag and bag! Marking it as a write conflict key stops 
          recent.addWriteConflictKey(candidate)
          return tuple.pack(candidate)
        }
      }
    }
  }
}

const DEFAULT_NODE_PREFIX = Buffer.from([0xfe])
const HCA_PREFIX = Buffer.from('hca', 'ascii')
const VERSION_KEY = Buffer.from('version', 'ascii')
const LAYER_KEY = Buffer.from('layer', 'ascii')
const PARTITION_BUF = Buffer.from('partition', 'ascii') // I hate this.
const SUBDIRS_KEY = 0 // Why is this 0 when version / layers are byte strings? I have no idea. History, I assume.

const EXPECTED_VERSION: Version = [1, 0, 0]

type PathIn = string | string[] | null | undefined
type Path = string[]

// Clean up whatever junk the user gives us. I ordinarily wouldn't do this but
// its consistent with the python and ruby bindings.
const normalize_path = (path: PathIn): Path => {
  return path == null
    ? []
    : Array.isArray(path)
      ? path
      : [path]
  // if (!Array.isArray(path)) path = [path]

  // for (let i = 0; i < path.length; i++) {
  //   if (typeof path[i] !== 'string') path[i] = path[i].toString()
  // }

  // return path as string[]
}

// Ugh why is this called 'node'?? The word 'node' is used throughout this file
// interchangably to mean a 'Node' (instance of this node class) or a node in
// the directory graph, represented by a subspace element representing directory
// metadata inside the node_root subspace. Its super confusing.
//
// This class is also *awful*. It has 3 states:
// - The target doesn't exist - in which case subspace is null
// - The target exists but metadata (the layer) hasn't been loaded. subspace
//   exists but layer is null
// - The target exists and metadata has been loaded.
class Node {
  // Frankly, I don't think this deserves a class all of its own, but this whole
  // file is complex enough, so I'm going to stick to a pretty straight
  // reimplementation of the python / ruby code here.
  subspace: NodeSubspace | null
  path: Path
  target_path: Path
  // The layer should be defined as a string, but the binding tester insists on
  // testing this with binary buffers which are invalid inside a string, so
  // we'll use buffers internally and expose an API accepting either. Sigh.
  layer: Buffer | null // Filled in lazily. Careful - this will most often be empty.

  constructor(subspace: NodeSubspace | null, path: Path, targetPath: Path) {
    this.subspace = subspace
    this.path = path
    this.target_path = targetPath
    this.layer = null
  }

  exists(): boolean {
    return this.subspace != null
  }

  async prefetchMetadata(txn: TxnAny) {
    if (this.exists() && this.layer == null) await this.getLayer(txn)
    return this
  }

  async getLayer(txn?: TxnAny) {
    if (this.layer == null) {
      // txn && console.log('key', txn!.at(this.subspace!).packKey(LAYER_KEY))
      // if (txn) console.log('xxx', (await txn.at(this.subspace!).get(LAYER_KEY)), this.path, this.target_path)

      // There's a semi-bug in the upstream code where layer won't be specified
      // on the root of the directory structure (thats the only directory which
      // has an implicit layer).
      //
      // What should the implicit layer be? The other bindings leave it as '',
      // even though its kinda a directory partition, so it probably should be
      // 'partition'.
      if (txn) this.layer = (await txn.at(this.subspace!).get(LAYER_KEY)) || BUF_EMPTY
      else throw new DirectoryError('Layer has not been read')
    }

    return this.layer!
  }

  isInPartition(includeEmptySubpath: boolean = false) {
    return this.exists()
      && this.layer && this.layer.equals(PARTITION_BUF)
      && (includeEmptySubpath || this.target_path.length > this.path.length)
  }

  getPartitionSubpath() {
    return this.target_path.slice(this.path.length)
  }

  async getContents<KeyIn, KeyOut, ValIn, ValOut>(directoryLayer: DirectoryLayer, keyXf: Transformer<KeyIn, KeyOut>, valueXf: Transformer<ValIn, ValOut>, txn?: TxnAny) {
    return this.subspace == null ? null : directoryLayer._contentsOfNode(this.subspace, this.path, await this.getLayer(txn), keyXf, valueXf)
  }

  getContentsSync<KeyIn, KeyOut, ValIn, ValOut>(directoryLayer: DirectoryLayer, keyXf: Transformer<any, any> = defaultTransformer, valueXf: Transformer<any, any> = defaultTransformer) {
    if (this.layer == null) throw new DirectoryError('Node metadata has not been fetched.')
    return this.subspace == null ? null : directoryLayer._contentsOfNode(this.subspace, this.path, this.layer!, keyXf, valueXf)
  }
}


// A directory is either a 'normal' directory or a directory partition.
// Partitions contain a separate directory layer inline into which the children
// are allocated.
// More on partitions: https://apple.github.io/foundationdb/developer-guide.html#directory-partitions
export class Directory<KeyIn = NativeValue, KeyOut = Buffer, ValIn = NativeValue, ValOut = Buffer> {
  /** The full path of the directory from the root */
  _path: Path

  _directoryLayer: DirectoryLayer
  _layer: Buffer | null
  content: Subspace<KeyIn, KeyOut, ValIn, ValOut>

  // If the directory is a partition, it also has a reference to the parent subspace.
  _parentDirectoryLayer?: DirectoryLayer

  constructor(parentDirectoryLayer: DirectoryLayer, path: Path, contentSubspace: Subspace<KeyIn, KeyOut, ValIn, ValOut>, isPartition: boolean, layer?: NativeValue) {
    this._path = path
    this.content = contentSubspace

    if (isPartition) {
      if (layer != null) throw new DirectoryError('Directory partitions cannot specify a layer.')

      // In partitions, the passed directory layer is the parent directory
      // layer. We create our own internally inside the partition.
      const directoryLayer = new DirectoryLayer({
        nodeSubspace: contentSubspace.atRaw(DEFAULT_NODE_PREFIX).withKeyEncoding(tuple).withValueEncoding(defaultTransformer),
        contentSubspace: contentSubspace,
      })
      directoryLayer._path = path
  
      // super(directoryLayer, path, subspace, 'partition')
      this._layer = PARTITION_BUF
  
      this._directoryLayer = directoryLayer
      this._parentDirectoryLayer = parentDirectoryLayer  
    } else {
      this._layer = layer ? asBuf(layer) : null
      this._directoryLayer = parentDirectoryLayer
      // this._parentDirectoryLayer is left as undefined for normal directories.
    }
  }

  getSubspace() {
    // Soooo I'm not entirely sure this is the right behaviour. The partition
    // itself should be read-only - that is, you shouldn't be inserting your own
    // children inside the directory partition. That said, one of the uses of a
    // directory partition is in being able to do a single range query to fetch
    // all children - and by refusing to return a subspace here we're making it
    // hard to run those queries.
    //
    // Refusing getSubspace() calls on directory partitions is the safe option
    // here from an API standpoint. I'll consider relaxing this constraint if
    // people complain about it.
    if (this.isPartition()) throw new DirectoryError('Cannot use a directory partition as a subspace.')
    else return this.content
  }

  // TODO: Add withKeyEncoding / withValueEncoding here.

  createOrOpen(txnOrDb: TxnAny | DbAny, path: PathIn, layer?: 'partition' | NativeValue) { // partition specified for autocomplete.
    return this._directoryLayer.createOrOpen(txnOrDb, this._partitionSubpath(path), layer)
  }
  
  open(txnOrDb: TxnAny | DbAny, path: PathIn, layer?: 'partition' | NativeValue) {
    return this._directoryLayer.open(txnOrDb, this._partitionSubpath(path), layer)
  }

  create(txnOrDb: TxnAny | DbAny, path: PathIn, layer?: 'partition' | NativeValue, prefix?: Buffer) {
    return this._directoryLayer.create(txnOrDb, this._partitionSubpath(path), layer, prefix)
  }
  
  async *list(txn: TxnAny, path: PathIn = []) {
    yield *this._directoryLayer.list(txn, this._partitionSubpath(path))
  }

  listAll(txnOrDb: TxnAny | DbAny, path: PathIn = []): Promise<Buffer[]> {
    return this._directoryLayer.listAll(txnOrDb, this._partitionSubpath(path))
  }

  move(txnOrDb: TxnAny | DbAny, oldPath: PathIn, newPath: PathIn) {
    return this._directoryLayer.move(txnOrDb, this._partitionSubpath(oldPath), this._partitionSubpath(newPath))
  }

  moveTo(txnOrDb: TxnAny | DbAny, _newAbsolutePath: PathIn) {
    const directoryLayer = this.getLayerForPath([])
    const newAbsolutePath = normalize_path(_newAbsolutePath)
    const partition_len = directoryLayer._path.length
    const partition_path = newAbsolutePath.slice(0, partition_len)
    if (!arrEq(partition_path, directoryLayer._path)) throw new DirectoryError('Cannot move between partitions.')

    return directoryLayer.move(txnOrDb, this._path.slice(partition_len), newAbsolutePath.slice(partition_len))
  }

  remove(txnOrDb: TxnAny | DbAny, path?: PathIn) {
    const layer = this.getLayerForPath(path)
    return layer.remove(txnOrDb, this._partitionSubpath(path, layer))
  }
  
  async removeIfExists(txnOrDb: TxnAny | DbAny, path?: PathIn) {
    const layer = this.getLayerForPath(path)
    return layer.removeIfExists(txnOrDb, this._partitionSubpath(path, layer))
  }

  exists(txnOrDb: TxnAny | DbAny, path?: PathIn): Promise<boolean> {
    const layer = this.getLayerForPath(path)
    return layer.exists(txnOrDb, this._partitionSubpath(path, layer))
  }


  getLayer() {
    // will be 'partition' for partitions.
    return this._layer ? this._layer.toString() : null
  }

  getLayerRaw() {
    return this._layer
  }

  getPath() {
    return this._path
  }

  isPartition() {
    return this._parentDirectoryLayer != null
  }

  private _partitionSubpath(path: PathIn, directoryLayer: DirectoryLayer = this._directoryLayer) {
    // console.log('_partitionSubpath', path, directoryLayer._path, this._path, this._path?.slice(directoryLayer._path.length).concat(normalize_path(path)))
    return this._path?.slice(directoryLayer._path.length).concat(normalize_path(path))
  }

  private getLayerForPath(path: PathIn): DirectoryLayer {
    return this.isPartition()
      ? normalize_path(path).length === 0
        ? this._parentDirectoryLayer!
        : this._directoryLayer
      : this._directoryLayer
  }
}

interface DirectoryLayerOpts {
  /** The prefix for directory metadata nodes. Defaults to '\xfe' */
  nodePrefix?: undefined | string | Buffer
  // We really actually want a NodeSubspace here, but we'll set the kv encoding
  // ourselves to make the API simpler.
  nodeSubspace?: undefined | SubspaceAny

  /** The prefix for content. Defaults to ''. */
  contentPrefix?: undefined | string | Buffer // Defaults to '', the root.
  contentSubspace?: undefined | SubspaceAny

  allowManualPrefixes?: undefined | boolean // default false
}

export class DirectoryLayer {
  _nodeSubspace: NodeSubspace
  _contentSubspace: Subspace<TupleIn, TupleItem[], any, any>
  _allowManualPrefixes: boolean
  
  _rootNode: NodeSubspace

  _allocator: HighContentionAllocator

  _path: Path

  constructor(opts: DirectoryLayerOpts = {}) {
    // By default, metadata for the nodes & allocator lives at the 0xfe prefix.
    // The root of the database has the values themselves, using the allocation
    // number as the prefix. Note that 0xfe (the default node prefix) is intentionally
    // an invalid tuple.
    
    this._nodeSubspace = opts.nodeSubspace?.withKeyEncoding(tuple)
      || new Subspace(opts.nodePrefix == null ? DEFAULT_NODE_PREFIX : opts.nodePrefix, tuple, defaultTransformer)
    
    this._contentSubspace = opts.contentSubspace?.withKeyEncoding(tuple)
      || new Subspace(opts.contentPrefix == null ? BUF_EMPTY : opts.contentPrefix, tuple, defaultTransformer)
    
    this._allowManualPrefixes = opts.allowManualPrefixes || false
    
    this._rootNode = this._nodeSubspace.at(this._nodeSubspace.prefix)
    this._allocator = new HighContentionAllocator(this._rootNode.at(HCA_PREFIX))

    // When the directory layer is actually a partition, this is overwritten.
    this._path = []
  }

  getPath() { return this._path }

  /**
   * Opens the directory with the given path.
   *
   * If the directory does not exist, it is created (creating parent directories
   * if necessary).
   *
   * If layer is specified, it is checked against the layer of an existing
   * directory or set as the layer of a new directory.
   */
  createOrOpen<KeyIn, KeyOut, ValIn, ValOut>(txnOrDb: DbOrTxn<KeyIn, KeyOut, ValIn, ValOut>, path: PathIn, layer?: 'partition' | NativeValue): Promise<Directory<KeyIn, KeyOut, ValIn, ValOut>> {
    return this._createOrOpenInternal(txnOrDb, path, layer)
  }

  private async _createOrOpenInternal<KeyIn, KeyOut, ValIn, ValOut>(txnOrDb: TxnAny | DbAny, _path: PathIn, layer: NativeValue = BUF_EMPTY, reqPrefix?: Buffer, allowCreate: boolean = true, allowOpen: boolean = true): Promise<Directory<KeyIn, KeyOut, ValIn, ValOut>> {
    const path = normalize_path(_path)
    // For layers, an empty string is treated the same as a missing layer property.
    const layerBuf = asBuf(layer)
    const {keyXf, valueXf} = txnOrDb.subspace

    if (reqPrefix != null && !this._allowManualPrefixes) {
      if (path.length === 0) throw new DirectoryError('Cannot specify a prefix unless manual prefixes are enabled.')
      else throw new DirectoryError('Cannot specify a prefix in a partition.')
    }
    
    if (path.length === 0) throw new DirectoryError('The root directory cannot be opened.')
    
    return doTxn(txnOrDb, async txn => {
      await this._checkVersion(txn, false)
      
      const existing_node = await this.findWithMeta(txn, path)
      if (existing_node.exists()) {
        // The directory exists. Open it!
        if (existing_node.isInPartition()) {
          const subpath = existing_node.getPartitionSubpath()
          // console.log('existing node is in partition at path', existing_node, existing_node.getPartitionSubpath())

          // This is pretty ugly. We're only using the existing node's directory layer. Better to
          // just create that child directory layer directly or something.
          return await existing_node.getContentsSync(this)!._directoryLayer._createOrOpenInternal(
            txn, subpath, layer, reqPrefix, allowCreate, allowOpen
          )
        } else {
          if (!allowOpen) throw new DirectoryError('The directory already exists.')
          // console.log('existing_node.layer', existing_node.layer, layerBuf)
          if (layerBuf.length && !existing_node.layer!.equals(layerBuf)) throw new DirectoryError('The directory was created with an incompatible layer.')

          return existing_node.getContentsSync(this, keyXf, valueXf)!
        }

      } else {
        // The directory does not exist. Create it!
        if (!allowCreate) throw new DirectoryError('The directory does not exist.')
        await this._checkVersion(txn, true)

        // We need to preserve the passed in prefix argument so if the prefix is null and we
        // generate a txn conflict, we generate a new prefix in the next retry attempt.
        let actualPrefix
        if (reqPrefix == null) {
          // const subspace = this._contentSubspace.at(await this._allocator.allocate(txn))
          actualPrefix = concat2(this._contentSubspace.prefix, await this._allocator.allocate(txn))
          if ((await txn.at(root).getRangeAllStartsWith(actualPrefix, {limit: 1})).length > 0) {
            throw new DirectoryError('The database has keys stored at the prefix chosen by the automatic prefix allocator: ' + inspect(actualPrefix))
          }

          if (!await this._isPrefixFree(txn.snapshot(), actualPrefix)) {
            throw new DirectoryError('The directory layer has manually allocated prefixes that conflict with the automatic prefix allocator.')
          }
        } else {
          if (!await this._isPrefixFree(txn, reqPrefix)) {
            throw new DirectoryError('The given prefix is already in use.')
          }
          actualPrefix = reqPrefix
        }

        const parentNode = path.length > 1
          ? this._nodeWithPrefix((await this._createOrOpenInternal(txn, path.slice(0, -1))).content.prefix)
          : this._rootNode

        if (parentNode == null) throw new DirectoryError('The parent directory does not exist.')

        const node = this._nodeWithPrefix(actualPrefix)
        // Write metadata
        txn.at(parentNode).set([SUBDIRS_KEY, path[path.length - 1]], actualPrefix)
        txn.at(node).set(LAYER_KEY, layerBuf)

        return this._contentsOfNode(node, path, layerBuf, keyXf, valueXf)
      }
    })
  }

  /**
   * Opens the directory with the given path.
   *
   * An error is raised if the directory does not exist, or if a layer is
   * specified and a different layer was specified when the directory was
   * created.
   */
  open<KeyIn, KeyOut, ValIn, ValOut>(txnOrDb: DbOrTxn<KeyIn, KeyOut, ValIn, ValOut>, path: PathIn, layer: 'partition' | NativeValue = BUF_EMPTY): Promise<Directory<KeyIn, KeyOut, ValIn, ValOut>> {
    return this._createOrOpenInternal(txnOrDb, path, layer, undefined, false, true)
  }

  /**
   * Creates a directory with the given path (creating parent directories if
   * necessary).
   *
   * An error is raised if the given directory already exists.
   *
   * If prefix is specified, the directory is created with the given physical
   * prefix; otherwise a prefix is allocated automatically.
   *
   * If layer is specified, it is recorded with the directory and will be
   * checked by future calls to open.
   */
  create<KeyIn, KeyOut, ValIn, ValOut>(txnOrDb: DbOrTxn<KeyIn, KeyOut, ValIn, ValOut>, path: PathIn, layer: 'partition' | NativeValue = BUF_EMPTY, prefix?: Buffer): Promise<Directory<KeyIn, KeyOut, ValIn, ValOut>> {
    return this._createOrOpenInternal(txnOrDb, path, layer, prefix, true, false)
  }
  
  /**
   * Moves the directory found at `old_path` to `new_path`.
   *
   * There is no effect on the physical prefix of the given directory, or on
   * clients that already have the directory open.
   *
   * An error is raised if the old directory does not exist, a directory already
   * exists at `new_path`, or the parent directory of `new_path` does not exist.
   *
   * This funtion returns the new directory. The old directory should no longer
   * be used.
   */
  move<KeyIn, KeyOut, ValIn, ValOut>(txnOrDb: DbOrTxn<KeyIn, KeyOut, ValIn, ValOut>, _oldPath: PathIn, _newPath: PathIn): Promise<Directory<KeyIn, KeyOut, ValIn, ValOut>> {
    const oldPath = normalize_path(_oldPath)
    const newPath = normalize_path(_newPath)

    return doTxn(txnOrDb, async txn => {
      // Ideally this call should only write the version information to the
      // database after performing the other checks, to make sure the input here
      // is valid. But that would be inconsistent with the other bindings, and
      // it matters because that inconsistency causes the binding tester to
      // fail: https://github.com/apple/foundationdb/issues/2925
      await this._checkVersion(txn, true)

      if (arrStartsWith(newPath, oldPath)) {
        throw new DirectoryError('The destination directory cannot be a subdirectory of the source directory.')
      }
      const oldNode = await this.findWithMeta(txn, oldPath)
      const newNode = await this.findWithMeta(txn, newPath)

      if (!oldNode.exists()) throw new DirectoryError('The source directory does not exist.')

      if (oldNode.isInPartition() || newNode.isInPartition()) {
        // This is allowed if and only if we're moving between two paths within the same partition.
        if (!oldNode.isInPartition() || !newNode.isInPartition() || !arrEq(oldNode.path, newNode.path)) {
          throw new DirectoryError('Cannot move between partitions.')
        }

        // Delegate to the partition.
        return newNode.getContentsSync(this)!.move(txn, oldNode.getPartitionSubpath(), newNode.getPartitionSubpath())
      }

      if (newNode.exists()) throw new DirectoryError('The destination directory already exists. Remove it first.')

      const parentNode = await this.find(txn, newPath.slice(0, -1))
      if (!parentNode.exists()) throw new DirectoryError('The parent of the destination directory does not exist. Create it first.')

      // Ok actually move.
      const oldPrefix = this.getPrefixForNode(oldNode.subspace!)
      txn.at(parentNode.subspace!).set([SUBDIRS_KEY, newPath[newPath.length - 1]], oldPrefix)
      await this._removeFromParent(txn, oldPath)

      // We return a Directory here. Its kind of arbitrary - but I'll use the KV transformers from
      // the transaction for the new directory. Not perfect, but should be fine
      const {keyXf, valueXf} = txnOrDb.subspace
      return this._contentsOfNode(oldNode.subspace!, newPath, oldNode.layer!, keyXf, valueXf)
    })
  }

  /**
   * Removes the directory, its contents, and all subdirectories. Throws an
   * exception if the directory does not exist.
   *
   * Warning: Clients that have already opened the directory might still insert
   * data into its contents after it is removed.
   */
  remove(txnOrDb: TxnAny | DbAny, path: PathIn) {
    return this._removeInternal(txnOrDb, path, true)
  }
  
  /**
   * Removes the directory, its contents, and all subdirectories, if it exists.
   * Returns true if the directory existed and false otherwise.
   *
   * Warning: Clients that have already opened the directory might still insert
   * data into its contents after it is removed.
   */
  removeIfExists(txnOrDb: TxnAny | DbAny, path: PathIn) {
    return this._removeInternal(txnOrDb, path, false)
  }

  private _removeInternal(txnOrDb: TxnAny | DbAny, _path: PathIn, failOnNonexistent: boolean): Promise<boolean> {
    const path = normalize_path(_path)

    return doTxn(txnOrDb, async txn => {
      await this._checkVersion(txn, true)
      
      if (path.length === 0) throw new DirectoryError('The root directory cannot be removed.')
      
      const node = await this.findWithMeta(txn, path)
      
      if (!node.exists()) {
        if (failOnNonexistent) throw new DirectoryError('The directory does not exist.')
        else return false
      }
      
      if (node.isInPartition()) {
        return await node.getContentsSync(this)!
          ._directoryLayer
          ._removeInternal(txn, node.getPartitionSubpath(), failOnNonexistent)
      }
      
      await this._removeRecursive(txn, node.subspace!)
      await this._removeFromParent(txn, path)
      return true
    })
  }

  /**
   * Streams the names of the specified directory's subdirectories via a
   * generator.
   */
  async *list(txn: TxnAny, _path: PathIn): AsyncGenerator<Buffer, void, void> {
    await this._checkVersion(txn, false)
  
    const path = normalize_path(_path)
    const node = await this.findWithMeta(txn, path)
    if (!node.exists()) throw new DirectoryError('The directory does not exist.')
  
    if (node.isInPartition(true)) {
      yield* node.getContentsSync(this)!
        .list(txn, node.getPartitionSubpath())
    } else {
      for await (const [name] of this._subdirNamesAndNodes(txn, node.subspace!)) {
        yield name
      }
    }
  }

  /**
   * Returns the names of the specified directory's subdirectories as a list of
   * strings.
   */
  listAll(txnOrDb: TxnAny | DbAny, _path: PathIn = []): Promise<Buffer[]> {
    return doTxn(txnOrDb, async txn => {
      const results = []
      for await (const path of this.list(txn, _path)) results.push(path)
      return results
    })
  }

  /**
   * Returns whether or not the specified directory exists.
   */
  async exists(txnOrDb: TxnAny | DbAny, _path: PathIn = []): Promise<boolean> {
    return doTxn(txnOrDb, async txn => {
      await this._checkVersion(txn, false)

      const path = normalize_path(_path)
      const node = await this.findWithMeta(txn, path)

      if (!node.exists()) return false
      else if (node.isInPartition()) return node.getContentsSync(this)!.exists(txn, node.getPartitionSubpath())
      else return true
    })
  }


  private async _nodeContainingKey(txn: TxnAny, key: Buffer) {
    // This is a straight port of the equivalent function in the ruby / python
    // bindings.

    // Check if the key is actually *in* the node subspace
    if (startsWith(key, this._nodeSubspace.prefix)) return this._rootNode

    // .. check for any nodes in nodeSubspace which have the same name as key.
    // Note the null here is used because null is encoded as Buffer<00>, which
    // preserves the behaviour from the other bindings.
    const [prev] = await txn.at(this._nodeSubspace).getRangeAll(null, [key, null], {reverse: true, limit: 1})
    if (prev) {
      const [k] = prev
      const prev_prefix = k[0] as Buffer
      if (startsWith(key, prev_prefix)) return this._nodeWithPrefix(prev_prefix)
    }
    
    return null
  }

  private _nodeWithPrefix(prefix: Buffer): NodeSubspace {
    return this._nodeSubspace.at(prefix)
  }

  private getPrefixForNode(node: NodeSubspace) {
    // This is some black magic. We have a reference to the node's subspace, but
    // what we really want is the prefix. So we want to do the inverse to
    // this._nodeSubspace.at(...).
    return this._nodeSubspace._bakedKeyXf.unpack(node.prefix)[0] as Buffer
  }

  private contentSubspaceForNodeWithXF<KeyIn, KeyOut, ValIn, ValOut>(node: NodeSubspace, keyXf: Transformer<KeyIn, KeyOut>, valueXf: Transformer<ValIn, ValOut>) {
    return new Subspace(this.getPrefixForNode(node), keyXf, valueXf)
  }

  private contentSubspaceForNode(node: NodeSubspace) {
    return this.contentSubspaceForNodeWithXF(node, defaultTransformer, defaultTransformer)
  }

  private async find(txn: TxnAny, path: Path) {
    let node = new Node(this._rootNode, [], path)
    // There's an interesting problem where the node at the root will not have
    // the layer property set, because the layer in that case is implicit.
    // if (this._path.length === 0) node.layer = ''

    for (let i = 0; i < path.length; i++) {
      const ref = await txn.at(node.subspace!).get([SUBDIRS_KEY, path[i]])
      node = new Node(ref == null ? null : this._nodeSubspace.at(ref), path.slice(0, i+1), path)

      if (ref == null || (await node.getLayer(txn)).equals(PARTITION_BUF)) break
    }

    return node
  }

  private async findWithMeta(txn: TxnAny, target_path: Path) {
    const node = await this.find(txn, target_path)
    await node.prefetchMetadata(txn)
    return node
  }

  _contentsOfNode<KeyIn, KeyOut, ValIn, ValOut>(nodeSubspace: NodeSubspace, path: Path, layer: NativeValue = BUF_EMPTY, keyXf: Transformer<KeyIn, KeyOut>, valueXf: Transformer<ValIn, ValOut>): Directory<KeyIn, KeyOut, ValIn, ValOut> {
    // This is some black magic. We have a reference to the node's subspace, but
    // what we really want is the prefix. So we want to do the inverse to
    // this._nodeSubspace.at(...).
    const contentSubspace = this.contentSubspaceForNodeWithXF(nodeSubspace, keyXf, valueXf)

    const layerBuf = asBuf(layer)
    if (layerBuf.equals(PARTITION_BUF)) {
      return new Directory(this, this._path.concat(path), contentSubspace, true)
    } else {
      // We concat the path because even though the child might not be a partition, we might be.
      return new Directory(this, this._path.concat(path), contentSubspace, false, layerBuf)
    }
  }

  private async _checkVersion(_tn: TxnAny, writeAccess: boolean) {
    const tn = _tn.at(this._rootNode)
    const actualRaw = await tn.get(VERSION_KEY)

    if (actualRaw == null) {
      if (writeAccess) tn.set(VERSION_KEY, versionEncoder.pack(EXPECTED_VERSION))
    } else {
      // Check the version matches the version of this directory implementation.
      const actualVersion = versionEncoder.unpack(actualRaw)

      if (actualVersion[0] > EXPECTED_VERSION[0]) {
        throw new DirectoryError(`Cannot load directory with version ${actualVersion.join('.')} using directory layer ${EXPECTED_VERSION.join('.')}`)
      } else if (actualVersion[1] > EXPECTED_VERSION[1] && writeAccess) {
        throw new DirectoryError(`Directory with version ${actualVersion.join('.')} is read-only when opened using directory layer ${EXPECTED_VERSION.join('.')}`)
      }
    }
  }

  private async* _subdirNamesAndNodes(txn: TxnAny, node: NodeSubspace) {
    // TODO: This could work using async iterators to improve performance of searches on very large directories.
    for await (const [key, prefix] of txn.at(node).getRange(SUBDIRS_KEY)) {
      yield [key[1], this._nodeWithPrefix(prefix)] as [Buffer, NodeSubspace]
    }
  }

  private async _subdirNamesAndNodesAll(txn: TxnAny, node: NodeSubspace) {
    const items = []
    for await(const pair of this._subdirNamesAndNodes(txn, node)) items.push(pair)
    return items
  }

  private async _removeFromParent(txn: TxnAny, path: Path) {
    const parent = await this.find(txn, path.slice(0, -1))
    txn.at(parent.subspace!).clear([SUBDIRS_KEY, path[path.length - 1]])
  }

  private async _removeRecursive(txn: TxnAny, node: NodeSubspace) {
    for await (const [name, subnode] of this._subdirNamesAndNodes(txn, node)) {
      await this._removeRecursive(txn, subnode)
    }

    // Clear content
    txn.at(this.contentSubspaceForNode(node)).clearRangeStartsWith(BUF_EMPTY)

    // Clear metadata
    txn.at(node).clearRangeStartsWith(undefined)
  }

  // private _isPrefixFree(txn: TxnAny, subspace: Subspace<TupleIn, TupleItem, any, any>) {
  private async _isPrefixFree(txn: TxnAny, prefix: Buffer) {
    // Returns true if the given prefix does not "intersect" any currently
    // allocated prefix (including the root node). This means that it neither
    // contains any other prefix nor is contained by any other prefix.
    return prefix.length > 0
      && await this._nodeContainingKey(txn, prefix) == null
      && (await txn.at(this._nodeSubspace).getRangeAll(prefix, strInc(prefix), {limit: 1})).length === 0
  }
}


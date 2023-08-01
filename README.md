# FoundationDB NodeJS bindings

Node bindings for [FoundationDB](https://www.foundationdb.org/)!

- [Getting started](#usage)
- [Connecting to your database cluster](#connecting-to-your-cluster)
- [Database Transactions](#database-transactions)
- [Getting and setting values](#getting-and-setting-values)
- [Range reads](#range-reads)
- [Key selectors](#key-selectors)
- [Watches](#watches)
- [Tuple encoder](#tuple-encoder)
- [Directories](#directories)

> **NOTE ON WINDOWS SUPPORT*: Windows support for node-foundationdb is currently disabled due to a [missing file in the windows foundationdb MSI](https://forums.foundationdb.org/t/fdb-c-types-h-missing-in-windows-install-image/3817). Please bother the foundationdb team if this is important to you.

## Usage

**You need to [download the FDB client library](https://www.foundationdb.org/download/) on your machine before you can use this node module**. This is also true on any machines you deploy to. I'm sorry about that. We've been [discussing it in the forums](https://forums.foundationdb.org/t/how-do-bindings-get-an-appropriate-copy-of-fdb-c/311/1) [and on the issue tracker](https://github.com/josephg/node-foundationdb/issues/22).

This library only supports foundationdb 6.2.0 or later.

#### Step 1

[Install foundationdb](https://www.foundationdb.org/download/).

To connect to a remote cluster you need:

- A copy of the client library with matching major and minor version numbers. You really only need the `libfdb_c` dynamic library file to connect ([available on the fdb downloads page](https://www.foundationdb.org/download/)). But its usually easier to just install the fdb client library for your platform. See [Notes on API versions](#notes-on-api-versions) below for more information.
- A copy of the `fdb.cluster` file for your database cluster. If you have installed foundationdb on your local machine in the default location, a copy of this file will be discovered and used automatically.

#### Step 1b (macos only)

If you're on a mac, add `export DYLD_LIBRARY_PATH=/usr/local/lib` to your .zshrc or .bash_profile. This is [needed due to macos binary sandboxing](https://github.com/josephg/node-foundationdb/issues/42).

#### Step 2

```
npm install --save foundationdb
```

#### Step 3

Use it!

```javascript
const fdb = require('foundationdb')
fdb.setAPIVersion(700) // Must be called before database is opened

;(async () => {
  const dbRoot = fdb.open() // or open('/path/to/fdb.cluster')

  // Scope all of your application's data inside the 'myapp' directory in your database
  const db = dbRoot.at(await fdb.directory.createOrOpen(dbRoot, 'myapp'))
    .withKeyEncoding(fdb.encoders.tuple) // automatically encode & decode keys using tuples
    .withValueEncoding(fdb.encoders.json) // and values using JSON

  await db.doTransaction(async tn => {
    console.log('Book 123 is', await tn.get(['books', 123])) // Book 123 is undefined

    tn.set(['books', 123], {
      title: 'Reinventing Organizations',
      author: 'Laloux'
    })
  })
  
  console.log('now book 123 is', await db.get(['books', 123])) // shorthand for db.doTransaction(...)
  // now book 123 is { title: 'Reinventing Organizations', author: 'Laloux' }
})()
```

> Note: You must set the FDB API version before using this library. You can specify any version number ≤ the version of FDB you are using in your cluster. If in doubt, set it to 620.


# API

## Connecting to your cluster

FoundationDB servers and clients use a [cluster file](https://apple.github.io/foundationdb/api-general.html#cluster-file) (typically named `fdb.cluster`) to connect to a cluster.

The best way to connect to your foundationdb cluster is to just use:

```javascript
const fdb = require('foundationdb')
const db = fdb.open()
```

This will look for a cluster file in:

- The [default cluster file location](https://apple.github.io/foundationdb/administration.html#default-cluster-file). This should *just work* for local development.
- The location specified by the `FDB_CLUSTER_FILE` environment variable
- The current working directory

Alternately, you can manually specify a cluster file location:

```javascript
const fdb = require('foundationdb')
const db = fdb.open('/path/to/fdb.cluster')
```

The returned database database object can be scoped to work out of a prefix, with specified key & value encoders. [See scoping section below](#scoping--key--value-transformations) for more information.


## Configuration

> This is working, but documentation needs to be written. TODO.


## Database transactions

Transactions are the core unit of atomicity in FoundationDB.

You almost always want to create transactions via `db.doTransaction(async tn => {...})`. doTransaction takes a body function in which you interact with the database.

> `db.doTransaction` is aliased as `db.doTn`. Both forms are used interchangably in this document.

The transaction will automatically be committed when the function's promise resolves. If the transaction had conflicts, the code you provide will be retried with exponential backoff. (Yes, in rare cases any code in the transaction will be executed multiple times. Make sure its idempotent!)

`db.doTransaction` will pass your function's return value back to the caller.

Example:

```javascript
const val = await db.doTransaction(async tn => {
  const val = await tn.get('key1')
  tn.set('key2', 'val3')
  // ... etc.

  return val
})

doWork(val) // val is whatever your function returned above.
```

> **Note:** This function may be called multiple times in the case of conflicts.

*Danger 💣:* **DO NOT DO THIS!**:

```javascript
await db.doTransaction(async tn => {
  const val = await tn.get('key')
  doWork(val) // doWork may be called multiple times!
})
```

For simplicity, most transaction operations are aliased on the database object. For example:

```javascript
const val = await db.get('key')

// ... is a shorthand for:
const val = db.doTransaction(async tn => await tn.get('key'))
```

The db helper functions always return a promise, wheras many of the transaction functions are syncronous (eg *set*, *clear*, etc).

Using methods directly on the database object may seem lighter weight than creating a transaction, but these calls still create and commit transactions internally. If you do more than one database operation when processing an event, wrapping those operations in an explicit fdb transaction will be safer *and* more efficient at runtime.


### Getting values

To **read** key/value pairs in a transaction, call `get(key)`:

```javascript
const valueBytes = await db.doTransaction(async tn => {
  return await tn.get(mykey)
})
```

If you don't need a transaction you can call `get` on the database object directly:

```javascript
const valueBytes = await db.get(mykey)
```

Unless you have specified a value encoding, `get` returns the data via a nodejs `Buffer`.


### Setting values

To **store**, use `Transaction#set(key, value)` or `Database#set(key, value) => Promise`, eg:

```javascript
await db.doTransaction(async tn => {
  tn.set(mykey, value)
  // ...
})
```

or

```javascript
await db.set(mykey, value)
```

Note that `tn.set` is synchronous. All set operations are immediately visible to subsequent get operations inside the transaction, and visible to external users only after the transaction has been committed.

By default the key and value arguments must be either node Buffer objects or strings. You can use [key and value transformers](#key-and-value-transformation) for automatic argument encoding. If you want to embed numbers, UUIDs, or multiple fields in your keys we strongly recommend using [fdb tuple encoding](https://apple.github.io/foundationdb/data-modeling.html#tuples) for your keys:

```javascript
const fdb = require('fdb')

const db = fdb.open()
  .withKeyEncoding(fdb.encoders.tuple)
  .withValueEncoding(fdb.encoders.json)

await db.set(['class', 6], {teacher: 'fred', room: '101a'})

// ...

await db.get(['class', 6]) // returns {teacher: 'fred', room: '101a'}
```



## Scoping & Key / Value transformations

Some areas of your database will contain different data, and might be encoded using different schemes. To make interacting with larger databases easier, this you can create aliases of your database object, each configured to interact with a different subset of your data.

Each database and transaction object has a [*subspace*](https://apple.github.io/foundationdb/developer-guide.html#subspaces), which is made up of 3 configuration parameters:

- A *prefix*, prepended to the start of all keys
- A *key transformer*, which is a `pack` & `unpack` function pair for interacting with keys
- A *value transformer*, which is a `pack` & `unpack` function pair for interacting with values

If you are used to other bindings, note that subspaces in python/ruby/etc only contain a prefix and do not reference transformers.

Subspaces can be created implicitly, by scoping your database object with `db.at()` or explicitly - by creating a subspace.

The subspace is transparent to your application once the database has been configured. Prefixes are automatically prepended to all keys supplied to the API, and automatically removed from all keys returned via the API. So if you have some code that consumes a foundationdb database object, that code won't need to change if you decide to store your data with a different prefix.

### Prefixes

To add an application-specific prefix:

```javascript
// Prepend 'myapp' to all keys
const db = fdb.open('fdb.cluster').at('myapp.')

// ... Then use the database as normal
await db.set('hello', 'there') // Actually sets 'myapp.hello' to 'there'
await db.get('hello') // returns 'there', encoded as a buffer
```

They can be nested arbitrarily:

```javascript
const root = fdb.open('fdb.cluster')
const app = db.at('myapp.')
const books = app.at('books.') // Equivalent to root.at('myapp.books.')
```

Beware of prefixes getting too long. The byte size of a prefix is paid during each API call, (and it can get particularly expensive when doing a lot of large range queries) so you should keep your prefixes short. If you want complex subdivisions, consider using [directories](#directories) instead of subspaces whenever you can. More information about this tradeoff is in [the FDB developer guide](https://apple.github.io/foundationdb/developer-guide.html#directory-partitions).

You can also configure a subspace explicitly like this:

```javascript
const db = fdb.open('fdb.cluster')
const subspace = new fdb.Subspace('myapp.')
const app = db.at(subspace)

const books = subspace.at('books.')
const booksDb = db.at(books)
```

The fdb library exposes an empty subspace at `fdb.root` for convenience. The above code could instead use:

```javascript
const subspace = fdb.root.at('myapp.')
// ...
```


### Key and Value transformation

By default, the Node FoundationDB library accepts key and value input as either strings or Buffer objects, and always returns Buffers. This is usually not what you actually want in your application!

You can configure a database to always automatically transform keys and values via an *encoder*. An encoder is usually just a `pack` and `unpack` method pair. The following encoders are built into the library:

- `fdb.encoders.`**int32BE**: Integer encoding using big-endian 32 bit ints. (Big endian is preferred because it preserves lexical ordering)
- `fdb.encoders.`**string**: UTF-8 string encoding
- `fdb.encoders.`**buffer**: Buffer encoding. This doesn't actually do anything, but it can be handy to suppress typescript warnings when you're dealing with binary data.
- `fdb.encoders.`**json**: JSON encoding using the built-in JSON.stringify. This is not suitable for key encoding.
- `fdb.encoders.`**tuple**: Encode values using the standard FDB [tuple encoding](https://apple.github.io/foundationdb/data-modeling.html#tuples). [Spec here](https://github.com/apple/foundationdb/blob/master/design/tuple.md). [See Tuple Encoder section below](#tuple-encoder)

**Beware** JSON encoding is generally unsuitable as a key encoding. [See below for details](#tuple-encoder). JSON is only troublesome for key encoding - it works great for encoding FDB values.


Examples:

#### Using a key encoding:

```javascript
const db = fdb.open('fdb.cluster').withKeyEncoding(fdb.encoders.int32BE)

await db.set(123, 'hi')
await db.get(123) // returns 'hi' as a buffer
```


#### Or a value encoding:

```javascript
const db = fdb.open('fdb.cluster').withValueEncoding(fdb.encoders.json)

await db.set('hi', [1,2,3])
await db.get('hi') // returns [1,2,3]
```

#### With an explicit subspace

```javascript
const db = fdb.open('fdb.cluster')

const subspace = new fdb.Subspace().withKeyEncoding(fdb.tuple).at('stuff')

await db.at(subspace).set(['hi', 'there'], [1,2,3])

await db.get(['stuff', 'hi', 'there']) // returns [1,2,3]
```

Note that the key encoding was applied *first*, which allowed the tuple encoder to encode 'stuff'. If we swapped the order (`subspace.at('stuff').withKeyEncoding(fdb.tuple)`), the prefix 'stuff' would be converted to raw bytes rather than being encoded with the tuple encoder.


#### Custom encodings

You can define your own custom encoding by supplying your own `pack` & `unpack` function pair:

```javascript
const msgpack = require('msgpack-lite')

const db = fdb.open('fdb.cluster').withValueEncoding({
  pack: msgpack.encode,
  unpack: msgpack.decode,
})

await db.set('hi', ['x', 1.2, Buffer.from([1,2,3])])
await db.get('hi') // returns ['x', 1.2, Buffer.from([1,2,3])]
```


#### Chained prefixes

If you prefix a database which has a key encoding set, the prefix will be transformed by the encoding. This allows you to use the API like this:

```javascript
const rootDb = fdb.open('fdb.cluster').withKeyEncoding(fdb.encoders.tuple)

const appDp = rootDb.at('myapp') // alias of rootDb.at(['myapp'])
const books = appDb.at(['data', 'books']) // Equivalent to rootDb.at(['myapp', 'data', 'books'])
```


#### Multi-scoped transactions

You can update objects in multiple scopes within the same transaction via `tn.at(obj)` for any object that has a subspace (databases, directories, subspaces or other transactions). This will to create an alias of the transaction in object's subspace:

```javascript
const root = fdb.open('fdb.cluster').withKeyEncoding(fdb.encoders.tuple).at(['myapp'])
const data = root.getSubspace().at(['schools'])
const index = root.getSubspace().at(['index'])

root.at(data).doTransaction(async tn => {
  // Update values inside ['schools']
  tn.set('UNSW', 'some data ...')

  // Update the index, at ['index']:
  tn.at(index)
  .set(['bycountry', 'australia', 'UNSW'], '... cached index data')
})
```

Aliased transactions inherit their `isSnapshot` property from the object they were created from, and the prefix and encoders from the database parameter. They support the complete transaction API, including ranges, watches, etc.



## Other transaction methods

### getKey(selector)

`tn.getKey` or `db.getKey` is used to get a key in the database via a key or [key selector](#key-selectors). For example:

```javascript
const ks = require('foundationdb').keySelector

const key = await db.getKey(ks.firstGreaterThan('students.')) // Get the first student key
```

You can also specify a key to fetch the first key greater than or equal to the specified key.

```javascript
const key = await db.getKey('a') // returns the first key ≥ 'a' in the db.
```

getKey returns the key as a node buffer object unless you specify a key encoding.

This works particularly well combined with tuple encoding:

```javascript
const fdb = require('fdb')
const db = fdb.open()
  .withKeyEncoding(fdb.encoders.tuple)

const key = await db.getKey(['students', 'by_enrolment_date', 0])
const date = key[2] // The earliest enrolment date in the database
```

You can also do something like this to get & use the last key in a range. This is awkward with the API as it is right now, but its very fast & computationally efficient:

```javascript
const fdb = require('fdb')
const db = fdb.open()

// The next key after all the student scores
const afterScore = fdb.util.strInc(tuple.pack(['students', 'by_score']))

const key = await db.getKey(fdb.keySelector.lastLessThan(afterScore))

const highestScore = fdb.tuple.unpack(key)[2]
```


### clear(key), clearRange(start, end) and clearRangeStartsWith(prefix)

You can remove individual keys from the database via `clear(key)`. `clear(start, end)` removes all keys *start* ≥ key ≥ *end*. These methods *do not* support key selectors. If you want to use more complex rules to specify the keys to clear range, first call *getKey* to find your specific range boundary.

You can also call `clearRangeStartsWith(prefix)` to clear all keys with the specific prefix.

These methods are available on transaction or database objects. The transaction variants are syncronous, and the database variants return promises.


### Conflict Keys and ranges

> TODO addReadConflictKey(key), addReadConflictRange(start, end), addWriteConflictKey(key), addWriteConflictRange. Feature complete - but docs missing!


### Atomics

> TODO docs. This is feature complete. Please help write docs and submit a PR!


## Range reads

There are several ways to read a range of values. Note that large transactions give poor performance in foundationdb, and are considered [an antipattern](https://apple.github.io/foundationdb/known-limitations.html#large-transactions). If your transaction reads more than 1MB of data or is held open for 5+ seconds, consider rethinking your design.

By default all range reads return keys *start* ≥ key > *end*. Ie, reading a range from 'a' to 'z' would read 'a' but not 'z'. You can override this behaviour using [key selectors](#key-selectors).

All range read functions can be passed optional [range options](#range-options) as the last parameter.


### Async iteration

The easiest way to iterate through a range is using an async iterator with **getRange(start, end, [opts])**:

```javascript
db.doTransaction(async tn => {
  for await (const [key, value] of tn.getRange('x', 'y')) {
    console.log(key, 'is', value)
  }
})
```

[Async iteration](https://github.com/tc39/proposal-async-iteration) is a recent javascript feature. It is available in NodeJS 10+, Typescript and Babel. You can also [iterate an async iterator manually](#manual-async-iteration).

*Danger 💣:* Remember that your transaction body may be executed multiple times. This can especially be a problem for range reads because they can easily overflow the transaction read limit (default 1M) or time limit (default 5s). Bulk operations need to be more complex than a loop in a transaction. [More information here](https://apple.github.io/foundationdb/known-limitations.html#large-transactions)

Internally `getRange` fetches the data in batches, with a gradually increasing batch size.


Range reads work well with tuple keys:

```javascript
const db = fdb.open().withKeyEncoding(fdb.encoders.tuple)

db.doTransaction(async tn => {
  for await (const [key, studentId] of tn.getRange(
    ['students', 'byrank', 0],
    ['students', 'byrank', 10]
  )) {
    const rank = key[2] // 0-9, as the range is exclusive of the end.
    console.log(rank + 1, ': ', studentId)
  }
})
```


### Manual async iteration

If `for await` isn't available for your platform, you can manually iterate through the iterator like this:

```javascript
db.doTransaction(async tn => {
  const iter = tn.getRange('x', 'y')
  while (true) {
    const item = await iter.next()
    if (item.done) break

    const [key, value] = item.value
    console.log(key, 'is', value)
  }
})
```

This is completely equivalent to the logic above. Its just more verbose.

### Batch iteration

You can process range results in batches for slightly improved performance:

```javascript
db.doTransaction(async tn => {
  for await (const batch of tn.getRangeBatch('x', 'y')) {
    for (let i = 0; i < batch.length; i++) {
      const [key, value] = batch[i]
      console.log(key, 'is', value)
    }
  }
})
```

This has better performance better because it doesn't thrash the event loop as much.


### Read entire range

You can also bulk read a range straight into an array via **getRangeAll(start, end, [opts])**:

```javascript
await db.getRangeAll('x', 'y') // returns [[key1, val1], [key2, val2], ...]
```

or as part of a transaction:

```javascript
db.doTransaction(async tn => {
  // ...
  await tn.getRangeAll('x', 'y')
}
```

The returned object is a list of key, value pairs. Unless you have specified a key encoding, the key and value will be `Buffer` objects.

The entire range is loaded in a single network request via the `StreamingMode.WantAll` option, described below.


### Range Options

All range read functions take an optional `options` object argument with the following properties:

- **limit** (*number*): If specified and non-zero, indicates the maximum number of key-value pairs to return. If you call `getRangeRaw` with a specified limit, and this limit was reached before the end of the specified range, `getRangeRaw` will specify `{more: true}` in the result. In other range read modes, the returned range (or range iterator) will stop after the specified limit.
- **reverse** (*boolean*): If specified, key-value pairs will be returned in reverse lexicographical order beginning at the end of the range.
- **targetBytes** (*number*): If specified and non-zero, this indicates a (soft) cap on the combined number of bytes of keys and values to return. If you call `getRangeRaw` with a specified limit, and this limit was reached before the end of the specified range, `getRangeRaw` will specify `{more: true}` in the result. Specifying targetBytes is currently not supported by other range read functions. Please file a ticket if support for this feature is important to you.
- **streamingMode**: This defines the policy for fetching data over the network. Options are:
	- `fdb.StreamingMode.`**WantAll**: Client intends to consume the entire range and would like it all transferred as early as possible. *This is the default for `getRangeAll`*
	- `fdb.StreamingMode.`**Iterator**: The client doesn't know how much of the range it is likely to used and wants different performance concerns to be balanced. Only a small portion of data is transferred to the client initially (in order to minimize costs if the client doesn't read the entire range), and as the caller iterates over more items in the range larger batches will be transferred in order to minimize latency. *This is the default mode for all range functions except getRangeAll.*
	- `fdb.StreamingMode.`**Exact**: Infrequently used. The client has passed a specific row limit and wants that many rows delivered in a single batch. Consider `WantAll` StreamingMode instead. A row limit must be specified if this mode is used.
	- `fdb.StreamingMode.`**Small**: Infrequently used. Transfer data in batches small enough to not be much more expensive than reading individual rows, to minimize cost if iteration stops early.
	- `fdb.StreamingMode.`**Medium**: Infrequently used. Transfer data in batches sized in between small and large.
	- `fdb.StreamingMode.`**Large**: Infrequently used. Transfer data in batches large enough to be, in a high-concurrency environment, nearly as efficient as possible. If the client stops iteration early, some disk and network bandwidth may be wasted. The batch size may still be too small to allow a single client to get high throughput from the database, so if that is what you need consider the SERIAL StreamingMode.
	- `fdb.StreamingMode.`**Serial**: Transfer data in batches large enough that an individual client can get reasonable read bandwidth from the database. If the client stops iteration early, considerable disk and network bandwidth may be wasted.

For example:

```javascript
// Get 10 key value pairs from 'z' backwards.
await db.getRange('a', 'z', {reverse: true, limit: 10})
```


### Key selectors

All range read functions and `getKey` let you specify keys using [key selectors](https://apple.github.io/foundationdb/developer-guide.html#key-selectors). Key selectors are created using methods in `fdb.keySelector`:

- `fdb.keySelector.`**lastLessThan(key)**
- `fdb.keySelector.`**lastLessOrEqual(key)**
- `fdb.keySelector.`**firstGreaterThan(key)**
- `fdb.keySelector.`**firstGreaterOrEqual(key)**

For example, to get a range not including the start but including the end:

```javascript
const ks = require('foundationdb').keySelector

// ...
tn.getRange(
  ks.firstGreaterThan(start),
  ks.firstGreaterThan(end)
)
```

> **Note ⛑** The semantics are weird for specifying the end of the range. FDB range queries are *always* non-inclusive of the end of their range. In the above example FDB will find the next key greater than `end`, then *not include this key in the results*.

You can add or subtract an offset from a key selector using `fdb.keySelector.add(sel, offset)`. This counts *in keys*. For example, to find the key thats exactly 10 keys after key `'a'`:

```javascript
const ks = require('foundationdb').keySelector

await db.getKey(ks.add(ks.firstGreaterOrEqual('a'), 10))
```

You can also specify raw key selectors using `fdb.keySelector(key: string | Buffer, orEqual: boolean, offset: number)`. See [FDB documentation](https://apple.github.io/foundationdb/developer-guide.html#key-selectors) on how these are interpreted.

Key selectors work with scoped types. This will fetch all students with ranks 1-10, inclusive:

```javascript
const db = fdb.open().withKeyEncoding(fdb.encoders.tuple)
const index = db.at(['index'])

const students = index.getRangeAll(
  ['students', 'byrank', 1], // Defaults to firstGreaterOrEqual(...).
  fdb.firstGreaterThan(['students', 'byrank', 10])
)
```




## Version stamps

Foundationdb allows you to bake the current version number into a key or value in the database. The embedded version is called a *versionstamp*. It is an opaque 10 byte value. These values are monotonically increasing but non-continuous.

> *Danger 💣* These values are unique to your FDB cluster. You may run into issues if you ever export your data then re-import it into a different FDB cluster.

During a transaction you can get a promise to read the resulting version with `tn.getVersionstamp() => {promise: Promise<Buffer>}`. Note: 

- `getVersionstamp` may only be called on transactions with write operations
- The returned promise will not resolve until after the transaction has been committed. Awaiting this promise inside your transaction body will deadlock your program. For this reason, the returned value is wrapped in an object.

Example:

```javascript
const p = await db.doTn(async tn => {
  tn.set('key', 'val')
  return tn.getVersionstamp()
})

const versionstamp = await p.promise // 10 byte buffer
```

💣💣 This will deadlock:

```javascript
await db.doTn(async tn => {
  tn.set('key', 'val')
  await tn.getVersionstamp().promise // DEADLOCK!!!
})
```

---

There are two ways you can insert the current commit's versionstamp into keys and values in your database:

1. Manually via `setVersionstampSuffixedKey` / `setVersionstampPrefixedValue`
2. Transparently via the tuple API and `setVersionstampedKey` / `setVersionstampedValue`


### 1. Using manual versionstamps via setVersionstampSuffixedKey / setVersionstampPrefixedValue

Calling `tn.setVersionstampSuffixedKey(key, value, [extraKeySuffix])` or `tn.setVersionstampPrefixedValue(key, value)` will insert a versionstamp into a key or value, respectively. Both of these methods are available on both transactions and on the database object directly.

#### setVersionstampSuffixedKey(key, value, [extraKeySuffix])

Call `tn.setVersionstampSuffixedKey` to insert a key made up of `concat(key, versionstamp)` or `concat(key, versionstamp, extrakeysuffix)` into the database.

Example:

```javascript
db.setVersionstampSuffixedKey(Buffer([1,2,3]), 'someval')
// DB contains key [1,2,3, (10 byte versionstamp)] = 'someval'

// Or using the optional extra key suffix
db.setVersionstampSuffixedKey(Buffer([1,2,3]), 'someval', Buffer([0xaa, 0xbb]))
// DB contains key [1,2,3, (10 byte versionstamp), 0xaa, 0xbb] = 'someval'
```

#### setVersionstampPrefixedValue(key, [value], [extraValuePrefix]) and getVersionstampPrefixedValue(key)

Call setVersionstampPrefixedValue to insert a value into the database with content `concat(versionstamp, key)`.

You can fetch a value stored with setVersionstampPrefixedValue like normal using `tn.get()`, but if you do so you will need to manually decode the returned versionstamp value. This may also cause the decoding to fail if you're using a value encoder like JSON. Instead we provide a helper method `getVersionstampPrefixedValue(key) -> Promise<{stamp, value}>` which will automatically split the stamp and the value, and decode the value if necessary.

Example:

```javascript
await db.setVersionstampPrefixedValue('key', Buffer([1,2,3]))
// DB contains 'key' = [(10 byte versionstamp), 1,2,3]

// You can fetch this value using getVersionstampPrefixedValue:
const {stamp, value} = await db.getVersionstampPrefixedValue('key')
// stamp is a 10 byte versionstamp and value is Buffer([1,2,3])
```

Or with a value encoder:

```javascript
const db = fdb.open().withValueEncoding(fdb.encoders.json)
db.setVersionstampPrefixedValue('key1', {some: 'data'})

// ...

const {stamp, value} = await db.getVersionstampPrefixedValue('somekey')
assert.deepEqual(value, {some: 'data'})
```

Because versionstamps are unique to a transaction, you can use the versionstamp as a per-commit key. This can be useful for advanced indexing. For example:

```javascript
await db.doTxn(async tn => {
  tn.setVersionstampSuffixedKey('data/', LargeBlobData)
  tn.setVersionstampPrefixedValue('index/latestBlob') // the value is just the versionstamp.
})
```

Using API version 520+, setVersionstampPrefixedValue supports an optional `extravalueprefix` argument, which will be prepended to the start of the inserted value. Note that this parameter goes at the end of the arguments list.

```javascript
// setVerionstampPrefixedValue takes an optional extra prefix argument.
db.setVersionstampPrefixedValue('key2', Buffer([1,2,3]), Buffer([0xaa, 0xbb]))
// DB contains 'key2' = [0xaa, 0xbb, (10 byte versionstamp), 1,2,3]
```

There is no helper method to read & decode a value written this way. File a ticket if you want one.


### 2. Using versionstamps with the tuple layer

The tuple layer allows unbound versionstamp markers to be embedded inside values. When tuples with these markers are written to the database (via `setVersionstampedKey` and `setVersionstampedValue`), the marker is replaced with the commit's versionstamp.

Unlike normal versionstamps, versionstamps in tuples are are 12 bytes long. The first 10 bytes are the commit's versionstamp and the last 2 bytes consist of a per-transaction ID. (The first value written this way has an ID of 0, then 1, etc). This makes each written tuple versionstamp unique, even when they share a transaction.

In action:

```javascript
import * as fdb from 'foundationdb'
const db = fdb.open().withKeyEncoding(fdb.encoders.tuple)

const key = [1, 2, 'hi', fdb.tuple.unboundVersionstamp()]
await db.setVersionstampedKey(key, 'hi there')

console.log(key)
// [1, 2, 'hi', {type: 'versionstamp', value: Buffer<12 byte versionstamp>}]
```

You can also write versionstamped *values* using tuples, but only in API version 520+:

```javascript
import * as fdb from 'foundationdb'
const db = fdb.open().withValueEncoding(fdb.encoders.tuple)

const value = ['some', 'data', fdb.tuple.unboundVersionstamp()]
await db.setVersionstampedValue('somekey', value)

console.log(value)
// ['some', 'data', {type: 'versionstamp', value: Buffer<12 byte versionstamp>}]
```

If you insert multiple versionstamped keys / values in the same transaction, each will have a unique code after the versionstamp:

```javascript
import * as fdb from 'foundationdb'
const db = fdb.open().withValueEncoding(fdb.encoders.tuple)

const key1 = [1,2,3, tuple.unboundVersionstamp()]
const key2 = [1,2,3, tuple.unboundVersionstamp()]

await db.doTxn(async tn => {
  tn.setVersionstampedKey(key1, '1')
  tn.setVersionstampedKey(key2, '2') // Does not overwrite first insert!
})

// key1 is [1,2,3, {type: 'versionstamp', value: Buffer<10 bytes followed by 0x00, 0x00>}]
// key2 is [1,2,3, {type: 'versionstamp', value: Buffer<10 bytes followed by 0x00, 0x01>}]
```

You can override this behaviour by explicitly specifying the versionstamp's ID into your call to `tuple.unboundVersionstamp`:

```javascript
const key = [1,2,3, tuple.unboundVersionstamp(321)]
```

Notes:

- You cannot use tuples with unbound versionstamps in other database or transaction methods.
- The actual versionstamp is only filled in after the transaction is committed
- Once the value has been committed, you can use the tuple with `get` / `set` methods like normal
- Each tuple may only contain 1 unbound versionstamp
- If you don't want the versionstamp marker to be replaced by transaction, pass an extra `false` argument to `setVersionstampedKey` / `setVersionstampedValue`. Eg, `tn.setVersionstampedKey([...], 'val', false)`.




## Watches

Foundationdb lets you watch a key and get notified when the key changes. A watch will only fire once - if you want to find out every time a key is changed, you will need to re-issue the watch after it has fired.

You can read more about working with watches in the [FDB developer guide](https://apple.github.io/foundationdb/developer-guide.html#watches).

The simplest way to use watches is to call one of the helper functions on the database object:

```javascript
const watch = await db.doTn(async tn => {
  tn.set('foo', 'bar')
  return tn.watch('foo')
})

watch.promise.then(changed => {
  if (changed) console.log('foo changed')
  else console.log('Watch was cancelled')
})

setTimeout(() => {
  watch.cancel()
}, 1000)
```

Alternately, you can watch a value by calling one of three [helper methods](#watch-helpers) on the database object directly:

```javascript
const watch = db.getAndWatch('somekey')
console.log('value is currently', watch.value)
watch.then(() => console.log('and now it has changed'))
```


Watch objects have two properties:

- **promise**: A promise which will resolve when the watch fires, errors, or is cancelled. If the watch fires the promise will resolve with a value of *true*. If the watch is cancelled by the user, or if the containing transaction is aborted or conflicts, the watch will resolve to *false*.
- **cancel()**: Function to cancel the watch. When you cancel a watch it will immediately resolve the watch, passing a value of *false* to your function.

The promise resolves to a value of *true* (the watch succeeded normally) or *false* in any of these cases:

- The promise was cancelled by the user
- The transaction which created the promise was aborted due to a conflict
- The transaction was manually cancelled via `tn.rawCancel`

*Warning:* Watches won't fire until their transaction is committed. This will deadlock your program:

```javascript
db.doTn(async tn => {
  const watch = tn.watch('foo')
  await watch.promise // DO NOT DO THIS - This will deadlock your program
})
```

*Danger 💣:* **DO NOT DO THIS!** If you attach a listener to the watch inside your transaction, your resolver may fire multiple times because the transaction itself may run multiple times.

```javascript
db.doTn(async tn => {
  tn.watch('foo').then(changed => {
    // DO NOT DO THIS!
    doWork() // Function may be called multiple times
  })
})
```

There are two workarounds:

1. Check the value of `changed`. It will be *false* when the watch was aborted due to a conflict.
2. *Recommended*: Return the watch from the transaction, and wait for it to resolve outside of the transaction body:

```javascript
const watch = await db.doTn(async tn => {
  return tn.watch('foo')
})

await watch.promise
```

If you want to watch multiple values, return them all:

```javascript
const [watchFoo, watchBar] = await db.doTn(async tn => {
  return [
    tn.watch('foo'),
    tn.watch('bar'),
  ]
})
```

### Watch helpers

The easiest way to use watches is via one of 3 helper methods on the database object:

- `db.`**getAndWatch(key)**: Get a value and watch it for changes. Because `get` is called in the same transaction which created the watch, this is safe from race conditions. Returns a watch with a `value` property containing the key's value.
- `db.`**setAndWatch(key, value)**: Set a value and watch it for changes within the same transaction.
- `db.`**clearAndWatch(key)**: Clear a value and watch it for changes within the same transaction.

```javascript
const watch = db.setAndWatch('highscore', '1000')
await watch.promise
console.log('Your high score has been usurped!')
```


## Snapshot Reads

By default, FoundationDB transactions guarantee [serializable isolation](https://apple.github.io/foundationdb/developer-guide.html#acid), resulting in a state that is *as if* transactions were executed one at a time, even if they were executed concurrently. Serializability has little performance cost when there are few conflicts but can be expensive when there are many. FoundationDB therefore also permits individual reads within a transaction to be done as *snapshot reads*.

Snapshot reads differ from ordinary (serializable) reads by permitting the values they read to be modified by concurrent transactions, whereas serializable reads cause conflicts in that case. Like serializable reads, snapshot reads see the effects of prior writes in the same transaction. For more information on the use of snapshot reads, see [Snapshot reads](https://apple.github.io/foundationdb/developer-guide.html#snapshot-isolation) in the foundationdb documentation.

Snapshot reads are done using the same set of read functions, but executed against a *snapshot transaction* instead of a normal transaction object:

```javascript
const val = await db.doTransaction(async tn => {
  return await tn.snapshot().get(someKey)
})
```

or

```javascript
const val = await db.doTransaction(async tn => {
  const tns = tn.snapshot()
  return await tns.get(someKey)
})
```

Internally snapshot transaction objects are just shallow clones of the original transaction object, but with a flag set. They share the underlying FDB transaction with their originator. Inside a `doTransaction` block you can use the original transaction and snapshot transaction objects interchangeably as desired.


## Tuple encoder

Foundationdb keys can be arbitrary byte arrays, but byte arrays are awkward to work with in non-trivial databases. For most applications we recommend using [fdb tuples](https://apple.github.io/foundationdb/data-modeling.html#tuples) to encode your keys.

The tuple encoder is strongly recommended over JSON for key encoding because:

- JSON does not specify a canonical encoding. For example, `{a:4, b:3}` could be encoded as `{"a":4,"b":3}` or `{"b":3,"a":4}`. `1000000` could be encoded as `1e6`, `'⛄️'` could be encoded as `"⛄️"` or `"\u26c4"` and so on. Because FDB compares bytes in the key to fetch values, if the JSON encoder changes how it encodes your key, your data might vanish when you try to fetch it again later!
- When performing range queries, JSON-encoded values aren't ordered in any sensible way. For example, 10 is lexographically between 1 and 2.

These problems are addressed by using [FDB tuple encoding](https://apple.github.io/foundationdb/data-modeling.html#tuples). Tuple encoding is also supported by all FDB frontends, it formally (and carefully) defines ordering for all objects. It also supports transparent concatenation (tuple.pack(`'a'`) + tuple.pack(`'b'`) === tuple.pack(`['a', 'b']`)), so tuple values can be easily used as key prefixes without worrying too much.

You can use the tuple encoder for database values too if you like, the tuple encoding doesn't support objects so it can be more awkward to use compared to JSON / [msgpack](https://msgpack.org/index.html) / [protobuf](https://developers.google.com/protocol-buffers) / etc. And the unique benefits of the tuple encoder don't matter for value encoding.

The javascript foundationdb tuple encoder lives in [its own library](https://github.com/josephg/fdb-tuple), but it is depended on and re-exposed here. You can access the tuple encoder via `fdb.tuple.pack()`, `fdb.tuple.unpack()`, etc.

### Tuple API

The simplest way to use the tuple encoder for keys is to set the key encoder in a database or subspace:

```javascript
const fdb = require('fdb')

const db = fdb.open()
  .withKeyEncoding(fdb.encoders.tuple)
  .withValueEncoding(fdb.encoders.json)

await db.set('version', 6) // Equivalent to db.set(['version'], 6)
await db.set(['class', [6, 'a']], {teacher: 'fred', room: '101a'})
```

Once you have a subspace with tuple encoding, you can use .at() to scope it:

```javascript
const fdb = require('fdb')
const db = fdb.open()

const class = fdb.root.withKeyEncoding(fdb.tuple)
  .at('class')

// equivalent to .set(['class', [6, 'a']]).
await db.at(class).set([[6, 'a']], {teacher: 'fred', room: '101a'})
```

Note the embedded tuple key `[[6, 'a']]` is double array wrapped in this example. This is because tuple values are concatenated, and in this case the user wants the key `['class', [6, 'a']]`, not `['class', 6, 'a']`.


## Directories

Key prefixes can get very long, and they waste a lot of space when you have a lot of objects which share most of their key! For this reason its often useful to group together similar keys into a *directory*. A directory is basically an alias to a short name, which is then used as the prefix for your keys. So instead of having keys:

- `some/reallllly/long/path/a` => a
- `some/reallllly/long/path/b` => b
- `some/reallllly/long/path/c` => c
- ... etc

Instead with directories, this would look like:

- `{directory alias} some/reallllly/long/path/` => `_17_`
- `_17_a` => a
- `_17_b` => b
- `_17_c` => c
- ...

Whew thats better!

You can read more about the directory concept in the [foundationdb developer guide](https://apple.github.io/foundationdb/developer-guide.html#directories)

### Usage

You can create, open, move and remove directories using the API provided by `fdb.directory`:

```javascript
const db = fdb.open()
const messagesDir = await fdb.directory.createOrOpen(db, 'fav color')

await db.at(messagesDir).doTn(async txn => {
  txn.set('fred', 'hotpink')
})
```

> TODO: Flesh out the directory layer documentation here. The API is almost identical to the equivalent API in python / ruby.

## Notes on API versions

Since the very first release, FoundationDB has kept full backwards compatibility for clients behind an explicit call to `setAPIVersion`. In effect, client applications select the API semantics they expect to use and then the operations team should be able to deploy any version of the database software, so long as its not older than the specified version.

From the point of view of a nodejs fdb client application, there are effectively three semi-independant versions your app consumes:

1. **Cluster version**: The version of fdb you are running on your database cluster. Eg *6.2.11*
2. **API version**: The semantics of the FDB client API (which change sometimes between versions of FDB). This affects supported FDB options and whether or not transactions read-your-writes is enabled by default. Eg *620*. Must be ≤ cluster version.
3. **binding version**: The semver version of this library in npm. Eg *0.10.7*.

I considered tying this library's version to the API version. Then with every new release of FoundationDB we would need to increment the major version number in npm. Unfortunately, new API versions depend on new versions of the database itself. Tying the latest version of `node-foundationdb` to the latest version of the FDB API would require users to either:

- Always deploy the latest version of FDB, or
- Stick to an older version of this library, which may be missing useful features and bug fixes.

Both of these options would be annoying.

So to deal with this, you need to manage all API versions:

1. This library needs access to a copy of `libfdb_c` which is compatible with the fdb cluster it is connecting to. Usually this means major & minor versions should match.
2. The API version of foundationdb is managed via a call at startup to `fdb.setAPIVersion`. This must be ≤ the version of the db cluster you are connecting to, but ≥ the C API version which the bindings depend on (currently `620`). (This can be overridden by also passing a header version to `setAPIVersion` - eg `fdb.setAPIVersion(520, 520)`).
3. This package is versioned normally via npm & package.json.

You should be free to upgrade this library and your foundationdb database independantly. However, this library will only maintain support for API versions within a recent range. This is simply a constraint of development time & testing.


### Upgrading your cluster

While all of your code should continue to work with new versions of foundationdb without modification, at runtime your application needs access to the `fdb_c` dynamic library (`libfdb_c_6.0.15.so` / `libfdb_c_6.0.15.dylib` / `libfdb_c_6.0.15.dll`) with a major and minor version number which *exactly matches* the version of the database that you are connecting to. 💣💣 That means you cannot upgrade your database server without also changing files on each of your database clients!

Upgrading your database cluster without any application downtime is possible but tricky. You need to:

1. Deploy your client application with both old and new copies of the `libfdb_c` dynamic library file. You can point your application a directory containing copies of all versions of `libfdb_c` that you want it to support connecting with via the `EXTERNAL_CLIENT_DIRECTORY` environment variable or setting the `external_client_directory` network option. When the client connects to your database it will try all versions of the fdb library found in this directory. The `libfdb_c` dynamic library files can be downloaded directly from the [FDB Downloads page](https://www.foundationdb.org/download/).
2. Upgrade your foundationdb database instances. Your app should automatically reconnect using the new dynamic library version.
3. Once the database is upgraded, remove old, unused copies of the `libfdb_c` client library from your frontend machines as they may degrade performance.

Read more about the [multi-versioned client design here](https://apple.github.io/foundationdb/api-general.html#multi-version-client) and check the [the foundationdb forum](https://forums.foundationdb.org/c/using-foundationdb) for help and more information.

Note that the API version number is different from the version of FDB you have installed. The API version is what you pass to `fdb.setAPIVersion`. This version number can be lower than the supported API version of foundationdb. In practice, The API version only needs to be incremented when you want to use new foundationdb features. See FDB [release notes](https://apple.github.io/foundationdb/release-notes.html) for information on what has changed between versions.


## History

These bindings are based on an old version of FDB's bindings from years ago, with contributions form @skozin and others.

- The native binding code has been updated to work with modern versions of v8, and work with promises rather than callbacks.
- The javascript code has been almost entirely rewritten. It has been modernized, ported from JS to Typescript and changed to use promises throughout.

## License

This project is published under the MIT License. See the [LICENSE file](LICENSE) for details.

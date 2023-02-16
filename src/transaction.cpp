/*
 * FoundationDB Node.js API
 * Copyright (c) 2012 FoundationDB, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

#include <cstdlib>
// #include <cstdio>
#include <cassert>

#include "options.h"
#include "transaction.h"
// #include "FdbError.h"

#include "future.h"

// using namespace v8;
using namespace std;
// using namespace node;

#define TRY(expr) NAPI_OK_OR_RETURN_MAYBE(env, (expr))
#define TRY_V(expr) NAPI_OK_OR_RETURN_NULL(env, (expr))

static napi_ref cons_ref;


static napi_value empty(napi_env env, napi_callback_info info) {
  return NULL;
}

static void finalize(napi_env env, void* tn, void* finalize_hint) {
  fdb_transaction_destroy((FDB_transaction *)tn);
}

MaybeValue newTransaction(napi_env env, FDBTransaction *transaction) {
  napi_value ctor;
  TRY(napi_get_reference_value(env, cons_ref, &ctor));

  napi_value obj;
  TRY(napi_new_instance(env, ctor, 0, NULL, &obj));
  TRY(napi_wrap(env, obj, (void *)transaction, finalize, NULL, NULL));
  return wrap_ok(obj);
}

// This is a helper struct to move strings out of passed buffers into a format
// accessible to foundationdb. Objects of this class shouldn't be created
// directly - they should only be created and destroyed via toStringParams and
// destroyStringParams.
typedef struct StringParams {
  bool owned; // Marks if we're holding memory that needs to be freed.
  uint8_t *str;
  size_t len;

  // This code is mostly straight C code - I'm using these simply to make memory
  // leaks cause runtime assertions if the struct is used incorrectly. I feel
  // weird about mixing styles like this though.
  StringParams(): owned(false) {}
  ~StringParams() {
    // The object must be cleaned up manually using destroyStringParams, for
    // symmetry with toStringParams.
    assert(owned == false);
  }
} StringParams;

// This is a small buffer to avoid thrashing the allocator when reading keys and values.
// Its a very 95% solution, but it improves performance in the average case.
// TODO: Many functions make 2 string params objects; not 1. Add a second buffer here.
static bool buf_in_use = false;
static uint8_t sp_buf[1024];

// String arguments can either be buffers or strings. If they're strings we
// need to copy the bytes locally in order to utf8 convert the content.
static napi_status toStringParams(napi_env env, napi_value value, StringParams *result) {
  napi_valuetype type;
  NAPI_OK_OR_RETURN_STATUS(env, napi_typeof(env, value, &type));
  if (type == napi_string) {
    // First get the length.
    NAPI_OK_OR_RETURN_STATUS(env, napi_get_value_string_utf8(env, value, NULL, 0, &result->len));

    if (!buf_in_use && result->len < sizeof(sp_buf)) {
      result->owned = false;
      result->str = sp_buf;
      NAPI_OK_OR_RETURN_STATUS(env, napi_get_value_string_utf8(env, value, (char *)sp_buf, sizeof(sp_buf), NULL));
      buf_in_use = true; // After fetch function, so the buffer isn't held if an error happens.
    } else {
      result->owned = true;
      result->str = (uint8_t *)malloc(result->len + 1);
      NAPI_OK_OR_RETURN_STATUS(env, napi_get_value_string_utf8(env, value, (char *)result->str, result->len + 1, NULL));
    }
  } else {
    result->owned = false;

    bool is_buffer;
    NAPI_OK_OR_RETURN_STATUS(env, is_bufferish(env, value, &is_buffer));

    if (is_buffer) {
      NAPI_OK_OR_RETURN_STATUS(env, get_buffer_info(env, value, (void **)&result->str, &result->len));
    } else {
      throw_if_not_ok(env, napi_throw_error(env, NULL, "Invalid param - must be string, buffer or arraybuffer"));
      return napi_pending_exception;
    }
  }
  return napi_ok;
}

static void destroyStringParams(StringParams *params) {
  if (params->owned) {
    free(params->str);
    params->owned = false; // Mark stringparams object as safe to delete.
  } else if (params->str == sp_buf) buf_in_use = false;
  params->str = NULL;
}


// dataOut must be a ptr to array of 8 items.
static void int64ToBEBytes(uint8_t* dataOut, uint64_t num) {
  for (int i = 0; i < 8; i++) {
    dataOut[7-i] = num & 0xff;
    num = num >> 8;
  }
}

// bytes be a ptr to an 8 byte array.
static uint64_t BEBytesToInt64(uint8_t* bytes) {
  uint64_t result = 0;
  for (int i = 0; i < 8; i++) {
    result <<= 8;
    result |= bytes[i];
  }
  return result;
}


// **** Extraction functions

static MaybeValue wrap_undefined(napi_env env) {
  MaybeValue result = {napi_ok, NULL};
  TRY(napi_get_undefined(env, &result.value));
  return result;
}

static MaybeValue ignoreResult(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  *errOut = fdb_future_get_error(future);
  return wrap_undefined(env);
}

static MaybeValue getValue(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  const uint8_t *value;
  int len;
  int valuePresent;

  *errOut = fdb_future_get_value(future, &valuePresent, &value, &len);
  if (UNLIKELY(*errOut)) return wrap_null();
  else if (!valuePresent) return wrap_undefined(env);

  // TODO
  // Its a bit yuck that we're copying so much memory here. It would be possible
  // to avoid this copy and add a reference from the returned buffer to the FDB
  // promise object for GC.
  napi_value result;
  TRY(napi_create_buffer_copy(env, (size_t)len, (void *)value, NULL, &result));
  return wrap_ok(result);
}

static MaybeValue getKey(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  const uint8_t *key;
  int len;
  *errOut = fdb_future_get_key(future, &key, &len);
  if (UNLIKELY(*errOut)) return wrap_null();

  // get_key can't / doesn't differentiate between returning the empty key ("")
  // or returning *no* key (ie, nothing exists which matches the given
  // selector). I'm not sure what the behaviour should be if you call getKey()
  // and we return an empty string here - that could either match the empty key,
  // or match *no* key.
  // There is a note about this here:
  // https://apple.github.io/foundationdb/developer-guide.html?#key-selectors
  napi_value result;
  TRY(napi_create_buffer_copy(env, (size_t)len, (void *)key, NULL, &result));
  return wrap_ok(result);
}

static MaybeValue getKeyValueList(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  const FDBKeyValue *kv;
  int len;
  fdb_bool_t more;

  *errOut = fdb_future_get_keyvalue_array(future, &kv, &len, &more);
  if (UNLIKELY(*errOut)) return wrap_null();

  /*
   * Constructing a JavaScript object with:
   * { results: [[key, value], [key, value], ...], more }
   */
  napi_value returnObj;
  TRY(napi_create_object(env, &returnObj));
  napi_value jsValueArray;
  TRY(napi_create_array_with_length(env, (size_t)len, &jsValueArray));

  for(int i = 0; i < len; i++) {
    napi_value pair;
    TRY(napi_create_array_with_length(env, 2, &pair));
    
    // TODO: Again, should be able to avoid this copy with clever use of references.
    napi_value keyBuf;
    TRY(napi_create_buffer_copy(env, kv[i].key_length, kv[i].key, NULL, &keyBuf));
    napi_value valBuf;
    TRY(napi_create_buffer_copy(env, kv[i].value_length, kv[i].value, NULL, &valBuf));

    TRY(napi_set_element(env, pair, 0, keyBuf));
    TRY(napi_set_element(env, pair, 1, valBuf));
    TRY(napi_set_element(env, jsValueArray, i, pair));
  }

  TRY(napi_set_named_property(env, returnObj, "results", jsValueArray));
  napi_value jsMore;
  TRY(napi_get_boolean(env, !!more, &jsMore));
  TRY(napi_set_named_property(env, returnObj, "more", jsMore));

  return wrap_ok(returnObj);
}

static MaybeValue getStringArray(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  const char **strings;
  int stringCount;

  *errOut = fdb_future_get_string_array(future, &strings, &stringCount);
  if (UNLIKELY(*errOut)) return wrap_null();

  napi_value jsArray;
  TRY(napi_create_array_with_length(env, stringCount, &jsArray));
  for(int i = 0; i < stringCount; i++) {
    napi_value str;
    TRY(napi_create_string_utf8(env, strings[i], NAPI_AUTO_LENGTH, &str));
    TRY(napi_set_element(env, jsArray, i, str));
  }

  return wrap_ok(jsArray);
}


static MaybeValue versionToJSBuffer(napi_env env, int64_t version) {
  // Versions are stored as an 8 byte buffer. They are stored big-endian so
  // standard lexical comparison functions will do what you expect.
  uint8_t data[8];
  int64ToBEBytes(data, (uint64_t)version);
  napi_value result;
  TRY(napi_create_buffer_copy(env, 8, (void *)data, NULL, &result));
  return wrap_ok(result);
}

static MaybeValue getInt64ToBuffer(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  int64_t version;
  *errOut = fdb_future_get_int64(future, &version);

  // See discussion about buffers vs storing the version as a JS number:
  // https://forums.foundationdb.org/t/version-length-is-53-bits-enough/260/6
  return UNLIKELY(*errOut) ? wrap_null() : versionToJSBuffer(env, version);
}

static MaybeValue getInt64ToNumber(napi_env env, FDBFuture* future, fdb_error_t* errOut) {
  int64_t val;
  *errOut = fdb_future_get_int64(future, &val);
  if (UNLIKELY(*errOut)) return wrap_null();

  napi_value result;
  TRY(napi_create_int64(env, val, &result));
  return wrap_ok(result);
}

// ***** End value extraction functions.


static napi_value setOption(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  set_option_wrapped(env, tr, OptTransaction, info);
  return NULL;
}

// commit()
static napi_value commit(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  FDBFuture *f = fdb_transaction_commit(tr);

  GET_ARGS(env, info, args, 1);
  return futureToJS(env, f, args[0], ignoreResult).value;
}

// Reset the transaction so it can be reused.
static napi_value reset(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (LIKELY(tr != NULL)) fdb_transaction_reset(tr);
  return NULL;
}

static napi_value cancel(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (LIKELY(tr != NULL)) fdb_transaction_cancel(tr);
  return NULL;
}

// See fdb_transaction_on_error documentation to see how to handle this.
// This is all wrapped by JS.
static napi_value onError(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  GET_ARGS(env, info, args, 2);

  fdb_error_t errorCode;
  TRY_V(napi_get_value_int32(env, args[0], &errorCode));
  FDBFuture *f = fdb_transaction_on_error(tr, errorCode);
  return futureToJS(env, f, args[1], ignoreResult).value;
}

static napi_value getApproximateSize(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  FDBFuture *f = fdb_transaction_get_approximate_size(tr);
  return futureToJS(env, f, NULL, getInt64ToNumber).value;
}


// Get(key, isSnapshot, [cb])
static napi_value get(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  GET_ARGS(env, info, args, 3);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));

  bool snapshot;
  TRY_V(napi_get_value_bool(env, args[1], &snapshot));

  FDBFuture *f = fdb_transaction_get(tr, key.str, key.len, snapshot);
  destroyStringParams(&key);
  return futureToJS(env, f, args[2], getValue).value;
}

/*
 * This function takes a KeySelector and returns a future.
 */
// GetKey(key, selOrEq, offset, isSnapshot, [cb])
static napi_value getKey(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  GET_ARGS(env, info, args, 5);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));

  bool selectorOrEqual;
  TRY_V(napi_get_value_bool(env, args[1], &selectorOrEqual));

  int32_t selectorOffset;
  TRY_V(napi_get_value_int32(env, args[2], &selectorOffset));

  bool snapshot;
  TRY_V(napi_get_value_bool(env, args[3], &snapshot));

  FDBFuture *f = fdb_transaction_get_key(tr, key.str, key.len, (fdb_bool_t)selectorOrEqual, selectorOffset, snapshot);
  destroyStringParams(&key);
  return futureToJS(env, f, args[4], getKey).value;
}

// set(key, val). Syncronous.
static napi_value set(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 2);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));
  StringParams val;
  TRY_V(toStringParams(env, args[1], &val));
  fdb_transaction_set(tr, key.str, key.len, val.str, val.len);

  destroyStringParams(&key);
  destroyStringParams(&val);
  return NULL;
}

// Delete value stored for key.
// clear("somekey")
static napi_value clear(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 1);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));

  fdb_transaction_clear(tr, key.str, key.len);

  destroyStringParams(&key);
  return NULL;
}

// atomicOp(key, operand key, mutationtype)
static napi_value atomicOp(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 3);

  int32_t operationType; // actually a FDBMutationType, but we'll store an int worth of memory.
  TRY_V(napi_get_value_int32(env, args[0], &operationType));

  StringParams key;
  TRY_V(toStringParams(env, args[1], &key));
  StringParams operand;
  TRY_V(toStringParams(env, args[2], &operand));

  fdb_transaction_atomic_op(tr, key.str, key.len, operand.str, operand.len, (FDBMutationType)operationType);

  destroyStringParams(&key);
  destroyStringParams(&operand);
  return NULL;
}

// getRange(
//   start, beginOrEqual, beginOffset,
//   end, endOrEqual, endOffset,
//   limit or 0, target_bytes or 0,
//   streamingMode, iteration,
//   snapshot, reverse,
//   [cb]
// )
static napi_value getRange(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  GET_ARGS(env, info, args, 13);

  StringParams start;
  TRY_V(toStringParams(env, args[0], &start));

  bool startOrEqual;
  TRY_V(napi_get_value_bool(env, args[1], &startOrEqual));
  int32_t startOffset;
  TRY_V(napi_get_value_int32(env, args[2], &startOffset));

  StringParams end;
  TRY_V(toStringParams(env, args[3], &end));
  bool endOrEqual;
  TRY_V(napi_get_value_bool(env, args[4], &endOrEqual));
  int32_t endOffset;
  TRY_V(napi_get_value_int32(env, args[5], &endOffset));

  int32_t limit;
  TRY_V(napi_get_value_int32(env, args[6], &limit));
  int32_t target_bytes;
  TRY_V(napi_get_value_int32(env, args[7], &target_bytes));
  
  int32_t modeInt;
  TRY_V(napi_get_value_int32(env, args[8], &modeInt));
  FDBStreamingMode mode = (FDBStreamingMode)modeInt;

  int32_t iteration;
  TRY_V(napi_get_value_int32(env, args[9], &iteration));
  bool snapshot;
  TRY_V(napi_get_value_bool(env, args[10], &snapshot));
  bool reverse;
  TRY_V(napi_get_value_bool(env, args[11], &reverse));

  FDBFuture *f = fdb_transaction_get_range(tr,
    start.str, start.len, (fdb_bool_t)startOrEqual, startOffset,
    end.str, end.len, (fdb_bool_t)endOrEqual, endOffset,
    limit, target_bytes,
    mode, iteration,
    snapshot, reverse);

  destroyStringParams(&start);
  destroyStringParams(&end);

  return futureToJS(env, f, args[12], getKeyValueList).value;
}

// clearRange(start, end). Clears range [start, end).
static napi_value clearRange(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 2);

  StringParams start;
  TRY_V(toStringParams(env, args[0], &start));
  StringParams end;
  TRY_V(toStringParams(env, args[1], &end));
  fdb_transaction_clear_range(tr, start.str, start.len, end.str, end.len);

  destroyStringParams(&start);
  destroyStringParams(&end);
  return NULL;
}

// watch("somekey", ignoreStandardErrors) -> {cancel(), promise}. This does
// not return a promise. Due to race conditions the callback may be called
// even after cancel has been called. The callback callback is *always* called
// even if the owning txn is cancelled, conflicts, or is discarded.
static napi_value watch(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 2);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));

  bool ignoreStandardErrors;
  TRY_V(napi_get_value_bool(env, args[1], &ignoreStandardErrors));

  FDBFuture *f = fdb_transaction_watch(tr, key.str, key.len);
  return watchFuture(env, f, ignoreStandardErrors).value;
}


// Not exposed to JS. Simple wrapper. Call AddReadConflictRange / AddWriteConflictRange.
static napi_value addConflictRange(napi_env env, napi_callback_info info, FDBConflictRangeType type) {
  // Its weird we're returning a value in these cases - we *always* return 0.
  // Doing it that way because it makes the macros simpler. Hopefully that gets
  // compiled out.
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 2);

  StringParams start;
  TRY_V(toStringParams(env, args[0], &start));
  StringParams end;
  TRY_V(toStringParams(env, args[1], &end));
  fdb_error_t errorCode = fdb_transaction_add_conflict_range(tr, start.str, start.len, end.str, end.len, type);

  destroyStringParams(&start);
  destroyStringParams(&end);

  if (errorCode != 0) throw_fdb_error(env, errorCode);
  return NULL;
}

// addConflictRange(start, end)
static napi_value addReadConflictRange(napi_env env, napi_callback_info info) {
  return addConflictRange(env, info, FDB_CONFLICT_RANGE_TYPE_READ);
}

// addConflictRange(start, end)
static napi_value addWriteConflictRange(napi_env env, napi_callback_info info) {
  return addConflictRange(env, info, FDB_CONFLICT_RANGE_TYPE_WRITE);
}


static napi_value getReadVersion(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 1);

  FDBFuture *f = fdb_transaction_get_read_version(tr);
  return futureToJS(env, f, args[0], getInt64ToBuffer).value;
}

// setReadVersion(version)
static napi_value setReadVersion(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 1);

  // The version parameter must be an 8 byte buffer.
  uint8_t* data;
  size_t len;
  TRY_V(get_buffer_info(env, args[0], (void **)&data, &len));

  if (len != 8) {
    throw_if_not_ok(env, napi_throw_error(env, NULL, "Invalid version buffer - must be 8 bytes"));
    return NULL;
  }

  int64_t version = (int64_t)BEBytesToInt64(data);
  fdb_transaction_set_read_version(tr, version);
  return NULL;
}


static napi_value getCommittedVersion(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;

  int64_t version;
  FDB_OK_OR_RETURN_NULL(env, fdb_transaction_get_committed_version(tr, &version));

  // Again, if we change version to be a byte array this will need to change too.
  return versionToJSBuffer(env, version).value;
}

static napi_value getVersionstamp(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 1);

  FDBFuture *f = fdb_transaction_get_versionstamp(tr);
  return futureToJS(env, f, args[0], getKey).value;
}

// getAddressesForKey("somekey", [cb])
static napi_value getAddressesForKey(napi_env env, napi_callback_info info) {
  FDBTransaction *tr = (FDBTransaction *)getWrapped(env, info);
  if (UNLIKELY(tr == NULL)) return NULL;
  GET_ARGS(env, info, args, 2);

  StringParams key;
  TRY_V(toStringParams(env, args[0], &key));

  FDBFuture *f = fdb_transaction_get_addresses_for_key(tr, key.str, key.len);
  destroyStringParams(&key);
  return futureToJS(env, f, args[1], getStringArray).value;
}



napi_status initTransaction(napi_env env) {
  napi_property_descriptor desc[] = {
    FN_DEF(setOption),
    FN_DEF(commit),
    FN_DEF(reset),
    FN_DEF(cancel),
    FN_DEF(onError),

    FN_DEF(getApproximateSize),

    FN_DEF(get),
    FN_DEF(getKey),
    FN_DEF(set),
    FN_DEF(clear),

    FN_DEF(atomicOp),

    FN_DEF(getRange),
    FN_DEF(clearRange),

    FN_DEF(watch),

    FN_DEF(addReadConflictRange),
    FN_DEF(addWriteConflictRange),

    FN_DEF(getReadVersion),
    FN_DEF(setReadVersion),
    FN_DEF(getCommittedVersion),
    FN_DEF(getVersionstamp),

    FN_DEF(getAddressesForKey),
  };

  napi_value constructor;
  NAPI_OK_OR_RETURN_STATUS(env, napi_define_class(env, "Transaction", NAPI_AUTO_LENGTH,
    empty, NULL, sizeof(desc)/sizeof(desc[0]), desc, &constructor));

  NAPI_OK_OR_RETURN_STATUS(env, napi_create_reference(env, constructor, 1, &cons_ref));
  return napi_ok;
}
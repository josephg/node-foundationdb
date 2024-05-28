#include <cassert>
#include <thread>

#include "utils.h"
#include "future.h"

// #include <cstdio>

// #include <v8.h>

// #include "Version.h"
// #include <foundationdb/fdb_c.h>

// #include "FdbError.h"

static napi_threadsafe_function tsf;
static int num_outstanding = 0;
std::thread::id node_main_thread;


template<class CtxType> struct CtxBase {
  FDBFuture *future;
  napi_status (*fn)(napi_env, FDBFuture*, CtxType*);

  // This is a little dirty, since we don't want to hold a reference to env.
  // This is here so when fdb_future_set_callback calls the callback directly we
  // can immediately call trigger.
  napi_env env;
};

static void trigger(napi_env env, napi_value _js_callback, void* _context, void* data) {
  CtxBase<void>* ctx = static_cast<CtxBase<void>*>(data);

  if (env != NULL) {
    --num_outstanding;
    if (num_outstanding == 0) {
      assert(0 == napi_unref_threadsafe_function(env, tsf));
    }

    napi_status status = ctx->fn(env, ctx->future, ctx);
    throw_if_not_ok(env, status);
    if (status == napi_pending_exception) {
      // We don't have a stack here. For some reason, if an exception is thrown
      // here it gets silently dropped.
      napi_value err;
      napi_get_and_clear_last_exception(env, &err);
      napi_fatal_exception(env, err);
    }
    // assert(status == napi_ok);
  }

  fdb_future_destroy(ctx->future);
  delete ctx;
}

napi_value unused_func;

// napi_create_threadsafe_function requires that we pass a JS function argument.
// The function is never called, but we still need to pass one anyway:
// See https://github.com/nodejs/node/issues/27592
napi_value unused(napi_env, napi_callback_info) {
  assert(0);
  return NULL;
}

napi_status initFuture(napi_env env) {
  node_main_thread = std::this_thread::get_id();

  char name[] = "unused_panic";
  NAPI_OK_OR_RETURN_STATUS(env, napi_create_function(env, name, sizeof(name)-1, unused, NULL, &unused_func));

  char resource_name[] = "fdbfuture";
  napi_value str;
  NAPI_OK_OR_RETURN_STATUS(env, napi_create_string_utf8(env, resource_name, sizeof(resource_name)-1, &str));
  NAPI_OK_OR_RETURN_STATUS(env,
    napi_create_threadsafe_function(env, unused_func, NULL, str, 16 /*queue size*/, 1, NULL, NULL, NULL, trigger, &tsf)
  );
  // Start the threadsafe function unreferenced, so node can exit cleanly if its never used.
  NAPI_OK_OR_RETURN_STATUS(env, napi_unref_threadsafe_function(env, tsf));

  return napi_ok;
}

// unused cleanup.
void closeFuture(napi_env env) {
  napi_release_threadsafe_function(tsf, napi_tsfn_abort);
}


template<class CtxType> static napi_status resolveFutureInMainLoop(napi_env env, FDBFuture *f, CtxType* ctx, napi_status (*fn)(napi_env env, FDBFuture *f, CtxType*)) {
  ctx->future = f;
  ctx->fn = fn;
  ctx->env = env;

  // Prevent node from closing until the future has resolved.
  if (num_outstanding == 0) {
    NAPI_OK_OR_RETURN_STATUS(env, napi_ref_threadsafe_function(env, tsf));
  }
  num_outstanding++;

  assert(0 == fdb_future_set_callback(f, [](FDBFuture *f, void *_ctx) {
    // raise(SIGTRAP);
    CtxType* ctx = static_cast<CtxType*>(_ctx);

    // Foundationdb will sometimes resolve this callback in the main thread. In
    // that case, we can't block because doing so could cause a deadlock - see
    // https://github.com/josephg/node-foundationdb/issues/41 .
    if (node_main_thread == std::this_thread::get_id()) {
      // Trigger immediately without going via threadsafe_function
      trigger(ctx->env, NULL, NULL, ctx);
    } else {
      ctx->env = NULL;
      assert(napi_ok == napi_call_threadsafe_function(tsf, ctx, napi_tsfn_blocking));
    }
  }, ctx));

  return napi_ok;
}


MaybeValue fdbFutureToJSPromise(napi_env env, FDBFuture *f, ExtractValueFn *extractFn) {
  // Using inheritance here because Persistent doesn't seem to like being
  // copied, and this avoids another allocation & indirection.
  struct Ctx: CtxBase<Ctx> {
    napi_deferred deferred;
    ExtractValueFn *extractFn;
  };
  Ctx *ctx = new Ctx; // Ownership passed to resolveFutureInMainLoop.
  ctx->extractFn = extractFn;

  napi_value promise;
  NAPI_OK_OR_RETURN_MAYBE(env, napi_create_promise(env, &ctx->deferred, &promise));

  napi_status status = resolveFutureInMainLoop<Ctx>(env, f, ctx, [](napi_env env, FDBFuture *f, Ctx *ctx) {
    fdb_error_t errcode = 0;
    MaybeValue value = ctx->extractFn(env, f, &errcode);

    napi_deferred deferred = ctx->deferred;
    // delete ctx;

    if (errcode != 0) {
      napi_value err;
      NAPI_OK_OR_RETURN_STATUS(env, wrap_fdb_error(env, errcode, &err));
      NAPI_OK_OR_RETURN_STATUS(env, napi_reject_deferred(env, deferred, err));
    } else if (value.status != napi_ok) {
      napi_value err;
      NAPI_OK_OR_RETURN_STATUS(env, napi_get_and_clear_last_exception(env, &err));
      NAPI_OK_OR_RETURN_STATUS(env, napi_reject_deferred(env, deferred, err));
    } else {
      if (value.value == NULL) NAPI_OK_OR_RETURN_STATUS(env, napi_get_null(env, &value.value));
      NAPI_OK_OR_RETURN_STATUS(env, napi_resolve_deferred(env, deferred, value.value));
    }

    // Needed to work around a bug where the promise doesn't actually resolve.
    // v8::Isolate *isolate = v8::Isolate::GetCurrent();
    // isolate->RunMicrotasks();
    return napi_ok;
  });

  if (status != napi_ok) {
    napi_resolve_deferred(env, ctx->deferred, NULL); // free the promise
    delete ctx;
    return wrap_err(status);
  } else return wrap_ok(promise);
}

MaybeValue fdbFutureToCallback(napi_env env, FDBFuture *f, napi_value cbFunc, ExtractValueFn *extractFn) {
  struct Ctx: CtxBase<Ctx> {
    napi_ref cbFunc;
    ExtractValueFn *extractFn;
  };
  Ctx *ctx = new Ctx;

  NAPI_OK_OR_RETURN_MAYBE(env, napi_create_reference(env, cbFunc, 1, &ctx->cbFunc));
  ctx->extractFn = extractFn;

  napi_status status = resolveFutureInMainLoop<Ctx>(env, f, ctx, [](napi_env env, FDBFuture *f, Ctx *ctx) {
    fdb_error_t errcode = 0;
    MaybeValue value = ctx->extractFn(env, f, &errcode);

    napi_value callback;
    NAPI_OK_OR_RETURN_STATUS(env, napi_get_reference_value(env, ctx->cbFunc, &callback));
    NAPI_OK_OR_RETURN_STATUS(env, napi_reference_unref(env, ctx->cbFunc, NULL));
    NAPI_OK_OR_RETURN_STATUS(env, napi_delete_reference(env, ctx->cbFunc));

    size_t argc = 1; // In case of error we just won't populate argv[1].
    napi_value argv[2] = {}; // (err, value).

    if (errcode != 0) NAPI_OK_OR_RETURN_STATUS(env, wrap_fdb_error(env, errcode, &argv[0]));
    else if (value.status != napi_ok) NAPI_OK_OR_RETURN_STATUS(env, napi_get_and_clear_last_exception(env, &argv[0]));
    else {
      argc = 2;
      NAPI_OK_OR_RETURN_STATUS(env, napi_get_undefined(env, &argv[0]));
      argv[1] = value.value;
    }

    napi_value global;
    NAPI_OK_OR_RETURN_STATUS(env, napi_get_global(env, &global));
    // We're discarding the return value here.
    NAPI_OK_OR_RETURN_STATUS(env, napi_call_function(env, global, callback, argc, argv, NULL));

    return napi_ok;
  });
  return wrap_err(status);
}

MaybeValue futureToJS(napi_env env, FDBFuture *f, napi_value cbOrNull, ExtractValueFn *extractFn) {
  napi_valuetype type;
  NAPI_OK_OR_RETURN_MAYBE(env, typeof_wrap(env, cbOrNull, &type));
  if (type == napi_undefined || type == napi_null) {
    return fdbFutureToJSPromise(env, f, extractFn);
  } else if (type == napi_function) {
    return fdbFutureToCallback(env, f, cbOrNull, extractFn);
  } else {
    return wrap_err(napi_throw_error(env, "", "Invalid callback argument call"));
  }
}


// *** Watch

// This seems overcomplicated, and I'd love to be able to use the functions
// above to do all this work. The problem is that fdb_future_cancel causes an
// abort() if the future has already resolved. So the JS object needs to
// somehow know that the promise has resolved. So I really want to hold a
// reference to the JS object. And its hard to strongarm the functions above
// into doing that. Doing it the way I am here is fine, but it means the API
// we expose to javascript either works with promises or callbacks but not
// both. I might end up redesigning some of this once I've benchmarked how
// promises perform in JS & C.

// TODO: Using classes here is overwraught.

static napi_ref watch_cons_ref;

static napi_value cancel(napi_env env, napi_callback_info info) {
  // If the future has already been cancelled, napi_unwrap returns an invalid argument error.
  napi_value obj;
  NAPI_OK_OR_RETURN_NULL(env, napi_get_cb_info(env, info, 0, NULL, &obj, NULL));
  FDBFuture *future;
  napi_status status = napi_unwrap(env, obj, (void **)&future);
  if (status == napi_ok && future) fdb_future_cancel(future);
  else if (status != napi_invalid_arg) {
    throw_if_not_ok(env, status);
  }

  // FDBFuture *future = (FDBFuture *)getWrapped(env, info);
  // if (future) fdb_future_cancel(future);
  return NULL;
}

static napi_value empty(napi_env env, napi_callback_info info) {
  return NULL;
}

static void finalize(napi_env env, void* tn, void* finalize_hint) {
  fdb_transaction_destroy((FDB_transaction *)tn);
}

napi_status initWatch(napi_env env) {
  napi_property_descriptor desc[] = {
    FN_DEF(cancel),
  };

  napi_value constructor;
  NAPI_OK_OR_RETURN_STATUS(env, napi_define_class(env, "Watch", NAPI_AUTO_LENGTH,
    empty, NULL, sizeof(desc)/sizeof(desc[0]), desc, &constructor));

  NAPI_OK_OR_RETURN_STATUS(env, napi_create_reference(env, constructor, 1, &watch_cons_ref));
  return napi_ok;
}

MaybeValue watchFuture(napi_env env, FDBFuture *f, bool ignoreStandardErrors) {
  struct Ctx: CtxBase<Ctx> {
    napi_ref jsWatch;
    // I probably don't need to store a persistant reference here since it
    // can't be GCed anyway because its stored on jsWatch. But I think this is
    // *more* correct..?
    napi_deferred deferred;
    bool ignoreStandardErrors;
  };
  Ctx *ctx = new Ctx;

  napi_value promise;
  NAPI_OK_OR_RETURN_MAYBE(env, napi_create_promise(env, &ctx->deferred, &promise));

  napi_value ctor;
  NAPI_OK_OR_RETURN_MAYBE(env, napi_get_reference_value(env, watch_cons_ref, &ctor));

  napi_value jsWatch;
  NAPI_OK_OR_RETURN_MAYBE(env, napi_new_instance(env, ctor, 0, NULL, &jsWatch));
  NAPI_OK_OR_RETURN_MAYBE(env, napi_wrap(env, jsWatch, (void *)f, finalize, NULL, NULL));

  // I'm sure there's a better way to attach this, but I can figure that out when moving to N-API.
  NAPI_OK_OR_RETURN_MAYBE(env, napi_set_named_property(env, jsWatch, "promise", promise));

  NAPI_OK_OR_RETURN_MAYBE(env, napi_create_reference(env, jsWatch, 1, &ctx->jsWatch));
  ctx->ignoreStandardErrors = ignoreStandardErrors;

  napi_status status = resolveFutureInMainLoop<Ctx>(env, f, ctx, [](napi_env env, FDBFuture *f, Ctx *ctx) {
    // This is cribbed from fdbFutureToJSPromise above. Bleh.
    fdb_error_t errcode = fdb_future_get_error(ctx->future);
    bool success = true;

    // You can no longer cancel the watcher. Remove the reference to the
    // future, which is about to be destroyed.
    napi_value jsWatch;
    NAPI_OK_OR_RETURN_STATUS(env, napi_get_reference_value(env, ctx->jsWatch, &jsWatch));
    NAPI_OK_OR_RETURN_STATUS(env, napi_reference_unref(env, ctx->jsWatch, NULL));
    NAPI_OK_OR_RETURN_STATUS(env, napi_delete_reference(env, ctx->jsWatch));

    // Unlink the handle to the future.
    NAPI_OK_OR_RETURN_STATUS(env, napi_remove_wrap(env, jsWatch, NULL));
    // By default node promises will crash the whole process. If the
    // transaction which created this watch promise is cancelled or conflicts,
    // what should we do here? 
    // 1 If we reject the promise, the process will crash by default.
    //   Preventing this with the current API is really awkward
    // 2 If we resolve the promise that doesn't really make a lot of sense
    // 3 If we leave the promise dangling.. that sort of violates the idea of a
    //   *promise*
    // 
    // By default I'm going to do option 2 (well, when ignoreStandardErrors is
    // passed, which happens by default).
    // 
    // The promise will resolve (true) normally, or (false) if it was aborted.
    if (errcode && ctx->ignoreStandardErrors && (
        errcode == 1101 // operation_cancelled
        || errcode == 1025 // transaction_cancelled
        || errcode == 1020)) { // not_committed (tn conflict)
      success = false;
      errcode = 0;
    }

    if (errcode != 0) {
      napi_value err;
      NAPI_OK_OR_RETURN_STATUS(env, wrap_fdb_error(env, errcode, &err));
      NAPI_OK_OR_RETURN_STATUS(env, napi_reject_deferred(env, ctx->deferred, err));
    } else {
      napi_value jsSuccess;
      NAPI_OK_OR_RETURN_STATUS(env, napi_get_boolean(env, success, &jsSuccess));
      NAPI_OK_OR_RETURN_STATUS(env, napi_resolve_deferred(env, ctx->deferred, jsSuccess));
    }

    return napi_ok;
  });

  if (status != napi_ok) {
    napi_resolve_deferred(env, ctx->deferred, NULL);
    napi_reference_unref(env, ctx->jsWatch, NULL);
    delete ctx;
    return wrap_err(status);
  } else return wrap_ok(jsWatch);
}

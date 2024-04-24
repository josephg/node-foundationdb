// The transformer type is used to transparently translate keys and values
// through an encoder and decoder function.

import {asBuf, concat2, strInc, startsWith} from './util'
import {UnboundStamp} from './versionstamp'

export type Transformer<In, Out> = {
  name?: undefined | string, // For debugging.

  // The tuple type supports embedding versionstamps, but the versionstamp
  // isn't known until the transaction has been committed.

  // TODO: I need a name for this fancy structure.
  pack(val: In): Buffer | string,
  unpack(buf: Buffer): Out,

  // These are hooks for the tuple type to support unset versionstamps
  packUnboundVersionstamp?(val: In): UnboundStamp,
  bakeVersionstamp?(val: In, versionstamp: Buffer, code: Buffer | null): void,

  /// Range which includes all "children" of this item, or whatever that means
  /// for the type. Added primarily to make it easier to get a range with some
  /// tuple prefix.
  range?(prefix: In): {begin: Buffer | string, end: Buffer | string},
}

const id = <T>(x: T) => x
export const defaultTransformer: Transformer<Buffer | string, Buffer> = {
  pack: id,
  unpack: id
}

export const defaultGetRange = <KeyIn, KeyOut>(prefix: KeyIn, keyXf: Transformer<KeyIn, KeyOut>): {begin: Buffer | string, end: Buffer | string} => ({
  begin: keyXf.pack(prefix),
  end: strInc(keyXf.pack(prefix)),
})

export const prefixTransformer = <In, Out>(prefix: string | Buffer, inner: Transformer<In, Out>): Transformer<In, Out> => {
  const _prefix = asBuf(prefix)
  const transformer: Transformer<In, Out> = {
    name: inner.name ? 'prefixed ' + inner.name : 'prefixTransformer',

    pack(v: In): Buffer | string {
      // If you heavily nest these it'll get pretty inefficient.
      const innerVal = inner.pack(v)
      return concat2(_prefix, asBuf(innerVal))
    },
    unpack(buf: Buffer) {
      if (!startsWith(buf, _prefix)) throw Error('Cannot unpack key outside of prefix range.')
      return inner.unpack(buf.slice(_prefix.length))
    },
  }

  if (inner.packUnboundVersionstamp) transformer.packUnboundVersionstamp = (val: In): UnboundStamp => {
    const innerVal = inner.packUnboundVersionstamp!(val)

    const unboundStamp: UnboundStamp = {
      data: concat2(_prefix, innerVal.data),
      stampPos: _prefix.length + innerVal.stampPos
    };

    if (innerVal.codePos != null) {
      unboundStamp.codePos = _prefix.length + innerVal.codePos;
    }

    return unboundStamp;
  }

  if (inner.bakeVersionstamp) transformer.bakeVersionstamp = inner.bakeVersionstamp.bind(inner)

  if (inner.range) transformer.range = prefix => {
    const innerRange = inner.range!(prefix)
    return {
      begin: concat2(_prefix, asBuf(innerRange.begin)),
      end: concat2(_prefix, asBuf(innerRange.end)),
    }
  }

  return transformer
}
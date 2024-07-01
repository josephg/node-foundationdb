// A subspace is a wrapper around a prefix and key and value transformers. This
// is nearly equivalent to subspaces in the other bindings - the difference is
// it also includes kv transformers, so a subspace here will also automatically
// encode and decode keys and values.

import { Transformer, prefixTransformer, defaultTransformer, defaultGetRange } from "./transformer"
import { NativeValue } from "./native"
import {
  asBuf, concat2, startsWith, strInc
} from "./util"
import { UnboundStamp } from './versionstamp.js'

const EMPTY_BUF = Buffer.alloc(0)

const concatPrefix = (p1: Buffer, p2: string | Buffer | null) => (
  p2 == null ? p1
    : p1.length === 0 ? asBuf(p2)
    : concat2(p1, asBuf(p2))
)


// Template parameters refer to the types of the allowed key and values you pass
// in to the database (eg in a set(keyin, valin) call) and the types of keys and
// values returned. KeyIn == KeyOut and ValIn == ValOut in almost all cases.
export default class Subspace<KeyIn = NativeValue, KeyOut = Buffer, ValIn = NativeValue, ValOut = Buffer> {
  prefix: Buffer // This is baked into bakedKeyXf but we hold it so we can call .at / .atPrefix.
  keyXf: Transformer<KeyIn, KeyOut>
  valueXf: Transformer<ValIn, ValOut>

  _bakedKeyXf: Transformer<KeyIn, KeyOut> // This is cached from _prefix + keyXf.

  constructor(rawPrefix: string | Buffer | null, keyXf?: Transformer<KeyIn, KeyOut>, valueXf?: Transformer<ValIn, ValOut>) {
    this.prefix = rawPrefix != null ? Buffer.from(rawPrefix) : EMPTY_BUF

    // Ugh typing this is a mess. Usually this will be fine since if you say new
    // Subspace() you'll get the default values for KI/KO/VI/VO.
    this.keyXf = keyXf || (defaultTransformer as Transformer<any, any>)
    this.valueXf = valueXf || (defaultTransformer as Transformer<any, any>)

    this._bakedKeyXf = rawPrefix ? prefixTransformer(rawPrefix, this.keyXf) : this.keyXf
  }

  // All these template parameters make me question my life choices, but this is
  // legit all the variants. Typescript can probably infer using less than this,
  // but I honestly don't trust it not to land with any or unknown or something
  // in some of the derived types
  at(prefix: KeyIn | null): Subspace<KeyIn, KeyOut, ValIn, ValOut>;
  at<CKI, CKO>(prefix: KeyIn | null, keyXf: Transformer<CKI, CKO>): Subspace<CKI, CKO, ValIn, ValOut>;
  at<CVI, CVO>(prefix: KeyIn | null, keyXf: undefined, valueXf: Transformer<CVI, CVO>): Subspace<KeyIn, KeyOut, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix: KeyIn | null, keyXf?: Transformer<CKI, CKO>, valueXf?: Transformer<CVI, CVO>): Subspace<CKI, CKO, CVI, CVO>;
  // ***
  at(prefix: KeyIn | null, keyXf: Transformer<any, any> = this.keyXf, valueXf: Transformer<any, any> = this.valueXf) {
    const _prefix = prefix == null ? null : this.keyXf.pack(prefix)
    return new Subspace(concatPrefix(this.prefix, _prefix), keyXf, valueXf)
  }

  /** At a child prefix thats specified without reference to the key transformer */
  atRaw(prefix: Buffer) {
    return new Subspace(concatPrefix(this.prefix, prefix), this.keyXf, this.valueXf)
  }


  withKeyEncoding<CKI, CKO>(keyXf: Transformer<CKI, CKO>): Subspace<CKI, CKO, ValIn, ValOut> {
    return new Subspace(this.prefix, keyXf, this.valueXf)
  }
  
  withValueEncoding<CVI, CVO>(valXf: Transformer<CVI, CVO>): Subspace<KeyIn, KeyOut, CVI, CVO> {
    return new Subspace(this.prefix, this.keyXf, valXf)
  }

  // GetSubspace implementation
  getSubspace() { return this }

  // Helpers to inspect whats going on.
  packKey(key: KeyIn): NativeValue {
    return this._bakedKeyXf.pack(key)
  }
  unpackKey(key: Buffer): KeyOut {
    return this._bakedKeyXf.unpack(key)
  }
  packKeyUnboundVersionstamp(key: KeyIn): UnboundStamp {
    if (!this._bakedKeyXf.packUnboundVersionstamp) {
      throw TypeError('Value encoding does not support unbound versionstamps. Use setVersionstampPrefixedValue instead')
    }

    return this._bakedKeyXf.packUnboundVersionstamp(key)
  }
  packValue(val: ValIn): NativeValue {
    return this.valueXf.pack(val)
  }
  unpackValue(val: Buffer): ValOut {
    return this.valueXf.unpack(val)
  }
  packValueUnboundVersionstamp(value: ValIn): UnboundStamp {
    if (!this.valueXf.packUnboundVersionstamp) {
      throw TypeError('Value encoding does not support unbound versionstamps. Use setVersionstampPrefixedValue instead')
    }

    return this.valueXf.packUnboundVersionstamp(value)
  }

  /**
   * Encodes a range specified by `start`/`end` pair using configured key encoder.
   *
   * @param start Start of the key range. If undefined, the start of the subspace is assumed.
   * @param end End of the key range. If undefined, the end of the subspace is assumed.
   * @returns Encoded range as a `{ begin, end }` record.
   */
  packRange(start?: KeyIn, end?: KeyIn): {begin: NativeValue, end: NativeValue} {
    return {
      begin: start !== undefined ? this._bakedKeyXf.pack(start) : this.prefix,
      end: end !== undefined ? this._bakedKeyXf.pack(end) : strInc(this.prefix)
    }
  }

  /**
   * Encodes a range specified by the prefix using configured key encoder.
   *
   * @param prefix Start of the key key range. If undefined, the start of the subspace is assumed.
   * @returns Encoded range as a `{ begin, end }` record.
   */
  packRangeStartsWith(prefix: KeyIn): {begin: NativeValue, end: NativeValue} {
    const encodePrefix = this._bakedKeyXf.range ?? defaultGetRange

    return encodePrefix(prefix, this._bakedKeyXf)
  }

  contains(key: NativeValue) {
    // TODO: This is a little dangerous - we should check if the key exists between this.keyXf.range().
    return startsWith(asBuf(key), this.prefix)
  }
}

export const root: Subspace = new Subspace(null, defaultTransformer, defaultTransformer)

export interface GetSubspace<KI, KO, VI, VO> {
  getSubspace(): Subspace<KI, KO, VI, VO>
}

export const isGetSubspace = <KI, KO, VI, VO>(obj: any): obj is GetSubspace<KI, KO, VI, VO> => {
  return obj != null && typeof obj === 'object' && 'getSubspace' in obj
}
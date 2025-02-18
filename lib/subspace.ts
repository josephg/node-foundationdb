// A subspace is a wrapper around a prefix and key and value transformers. This
// is nearly equivalent to subspaces in the other bindings - the difference is
// it also includes kv transformers, so a subspace here will also automatically
// encode and decode keys and values.

import { Transformer, prefixTransformer, defaultTransformer, defaultGetRange } from "./transformer"
import { NativeValue } from "./native"
import { asBuf, concat2, startsWith } from "./util"

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
  at(prefix?: KeyIn | null, keyXf?: undefined, valueXf?: undefined): Subspace<KeyIn, KeyOut, ValIn, ValOut>;
  at<CKI, CKO>(prefix: KeyIn | null | undefined, keyXf: Transformer<CKI, CKO>, valueXf?: undefined): Subspace<CKI, CKO, ValIn, ValOut>;
  at<CVI, CVO>(prefix: KeyIn | null | undefined, keyXf: undefined, valueXf: Transformer<CVI, CVO>): Subspace<KeyIn, KeyOut, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix: KeyIn | null | undefined, keyXf: Transformer<CKI, CKO>, valueXf: Transformer<CVI, CVO>): Subspace<CKI, CKO, CVI, CVO>;
  at<CKI, CKO>(prefix: KeyIn | null | undefined, keyXf?: Transformer<CKI, CKO>, valueXf?: undefined):
    | Subspace<KeyIn, KeyOut, ValIn, ValOut>
    | Subspace<CKI, CKO, ValIn, ValOut>;
  at<CVI, CVO>(prefix: KeyIn | null | undefined, keyXf: undefined, valueXf?: Transformer<CVI, CVO>):
    | Subspace<KeyIn, KeyOut, ValIn, ValOut>
    | Subspace<KeyIn, KeyOut, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix: KeyIn | null | undefined, keyXf: Transformer<CKI, CKO> | undefined, valueXf: Transformer<CVI, CVO>):
    | Subspace<KeyIn, KeyOut, CVI, CVO>
    | Subspace<CKI, CKO, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix: KeyIn | null | undefined, keyXf: Transformer<CKI, CKO>, valueXf?: Transformer<CVI, CVO>):
    | Subspace<CKI, CKO, ValIn, ValOut>
    | Subspace<CKI, CKO, CVI, CVO>;
  at<CKI, CKO, CVI, CVO>(prefix?: KeyIn | null, keyXf?: Transformer<CKI, CKO>, valueXf?: Transformer<CVI, CVO>):
    | Subspace<KeyIn, KeyOut, ValIn, ValOut>
    | Subspace<CKI, CKO, ValIn, ValOut>
    | Subspace<KeyIn, KeyOut, CVI, CVO>
    | Subspace<CKI, CKO, CVI, CVO>;
  at(prefix?: KeyIn | null, keyXf: Transformer<unknown, unknown> = this.keyXf, valueXf: Transformer<unknown, unknown> = this.valueXf) {
    const _prefix = prefix == null ? null : this.keyXf.pack(prefix)
    return new Subspace(concatPrefix(this.prefix, _prefix), keyXf, valueXf)
  }

  /** At a child prefix thats specified without reference to the key transformer */
  atRaw(prefix: Buffer) {
    return new Subspace(concatPrefix(this.prefix, prefix), this.keyXf, this.valueXf)
  }

  withKeyEncoding(keyXf?: undefined): Subspace<NativeValue, Buffer, ValIn, ValOut>
  withKeyEncoding<CKI, CKO>(keyXf: Transformer<CKI, CKO>): Subspace<CKI, CKO, ValIn, ValOut>
  withKeyEncoding<CKI, CKO>(keyXf?: Transformer<CKI, CKO>):
    | Subspace<NativeValue, Buffer, ValIn, ValOut>
    | Subspace<CKI, CKO, ValIn, ValOut>
  withKeyEncoding(keyXf?: Transformer<unknown, unknown>) {
    return new Subspace(this.prefix, keyXf, this.valueXf)
  }

  withValueEncoding(valueXf?: undefined): Subspace<KeyIn, KeyOut, NativeValue, Buffer>
  withValueEncoding<CVI, CVO>(valueXf: Transformer<CVI, CVO>): Subspace<KeyIn, KeyOut, CVI, CVO>
  withValueEncoding<CVI, CVO>(valueXf?: Transformer<CVI, CVO>):
    | Subspace<KeyIn, KeyOut, NativeValue, Buffer>
    | Subspace<KeyIn, KeyOut, CVI, CVO>
  withValueEncoding(valueXf?: Transformer<unknown, unknown>) {
    return new Subspace(this.prefix, this.keyXf, valueXf)
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
  packValue(val: ValIn): NativeValue {
    return this.valueXf.pack(val)
  }
  unpackValue(val: Buffer): ValOut {
    return this.valueXf.unpack(val)
  }

  packRange(prefix: KeyIn): {begin: NativeValue, end: NativeValue} {
    // if (this._bakedKeyXf.range) return this._bakedKeyXf.range(prefix)
    // else return defaultGetRange(prefix, this._bakedKeyXf)
    return (this._bakedKeyXf.range || defaultGetRange)(prefix, this._bakedKeyXf)
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
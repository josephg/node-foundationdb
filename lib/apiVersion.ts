import nativeMod from './native'

// To update:
// - regenerate lib/opts.g.ts using scripts/gentsopts.ts
// - re-run the test suite and binding test suite
export const MAX_VERSION = 730

let apiVersion: number | null = null
export const get = () => apiVersion

export function set(version: number, headerVersion?: number) {
  if (typeof version !== 'number') throw TypeError('version must be a number')

  if (apiVersion != null) {
    if (apiVersion !== version) {
      throw Error('foundationdb already initialized with API version ' + apiVersion)
    }
  } else {
    // Old versions probably work fine, but there are no tests to check.
    if (version < 500) throw Error('FDB Node bindings only support API versions >= 500')
    
    if (version > MAX_VERSION) {
      // I'd like allow it to work with newer versions anyway since API
      // changes seem to be backwards compatible, but nativeMod.setAPIVersion
      // will throw anyway.
      throw Error(`Cannot use foundationdb protocol version ${version} > ${MAX_VERSION}. This version of node-foundationdb only supports protocol versions <= ${MAX_VERSION}.

Please update node-foundationdb if you haven't done so then file a ticket:
https://github.com/josephg/node-foundationdb/issues

Until this is fixed, use FDB API version ${MAX_VERSION}.
`)
    }

    if (headerVersion == null) nativeMod.setAPIVersion(version)
    else nativeMod.setAPIVersionImpl(version, headerVersion)

    apiVersion = version
  }
}

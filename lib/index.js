/**
 * dsh-auto-email — entry shim.
 *
 * The Loader resolves this file (via the profile's `cordis.patch.yml`) and reads
 * `name`, `inject`, `Config` and `apply` from it. The implementation lives in
 * `plugin.js`, which this shim imports under a fresh `?rev=` query: a reconcile
 * of the profile patch then re-evaluates edited code instead of reusing Node's
 * module cache. Without a fresh query an edit appears to be ignored, because the
 * reload silently returns the already-evaluated module.
 *
 * `Date.now()` is what makes it fresh. The incoming `?rev=` is folded in only as
 * a traceability marker — relying on it alone would break the case where DSH
 * re-evaluates this file without changing the query string.
 */
const INCOMING = new URL(import.meta.url).searchParams.get('rev') ?? ''
const REVISION = `${INCOMING}-${Date.now().toString(36)}`

const mod = await import(`./plugin.js?rev=${REVISION}`)

export const name = mod.name
export const inject = mod.inject
export const Config = mod.Config
export const apply = mod.apply

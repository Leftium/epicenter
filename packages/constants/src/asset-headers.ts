/**
 * Response header carrying the owner's absolute storage usage in bytes
 * (`SUM(asset.sizeBytes)`) after a successful POST upload or DELETE.
 *
 * This is the protocol between two build targets. The billing-agnostic asset
 * routes in `@epicenter/server` emit it on 201/204; the cloud-only Autumn
 * storage policy in `apps/api/worker/billing/policies.ts` reads it to sync
 * Autumn with the absolute total. The asset table stays the accounting source
 * of truth, so the value is a plain post-mutation total, never a billing delta.
 * Deployments without billing (self-hosted team) just ignore it.
 */
export const ASSET_STORAGE_USAGE_TOTAL_HEADER = 'x-storage-usage-total-bytes';

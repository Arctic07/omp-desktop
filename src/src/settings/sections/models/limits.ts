/**
 * The provider-key bound, spelled once for the frontend.
 *
 * Its other home is `credentials::PROVIDER_KEYS_MAX` in
 * `src-tauri/src/services/credentials.rs`, because a cross-language constant cannot be shared; the
 * two are asserted to agree by the note that owns the decision
 * (`notes/implemented/architecture/2026-11-04-provider-key-pool-multi-key.md`).
 */
export const PROVIDER_KEYS_MAX = 8

/** Shared lineage limits. Depth counts child edges; root is depth zero. */
export const MAX_LINEAGE_DEPTH = 64;
// IdentitySession carries root/parent/worker aliases in addition to the
// lineage depth, so its serialized lineage has three framing handles.
export const MAX_LINEAGE_LENGTH = MAX_LINEAGE_DEPTH + 3;

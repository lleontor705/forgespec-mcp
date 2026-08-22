export const AUTHORITY_OPERATIONS = [
  "read_board",
  "read_task",
  "add",
  "update",
  "approve",
  "recover",
  "grant",
  "handoff",
  "revoke",
] as const;

export type AuthorityOperation = (typeof AUTHORITY_OPERATIONS)[number];

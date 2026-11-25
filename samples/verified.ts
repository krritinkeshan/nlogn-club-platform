import type { Profile } from "@/lib/types";

/**
 * The five things a member completes to be fully verified (user rule,
 * 2026-07-04). "Verification pending" shows until ALL are true, and the
 * blue seal appears at that same point.
 *   • cf        — Codeforces verified (also gates event registration on its own)
 *   • codechef  — CodeChef linked
 *   • atcoder   — AtCoder linked
 *   • leetcode  — LeetCode linked
 *   • username  — username claimed
 */
export function verificationChecklist(p: Profile) {
  return {
    cf: p.verification_status === "verified" && !!p.cf_handle,
    codechef: !!p.codechef_handle,
    atcoder: !!p.atcoder_handle,
    leetcode: !!p.leetcode_handle,
    username: !!p.username,
  };
}

/** True only when all five checklist items are done. */
export function isFullyVerified(p: Profile): boolean {
  return Object.values(verificationChecklist(p)).every(Boolean);
}

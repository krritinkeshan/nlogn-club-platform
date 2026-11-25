import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { getUsersInfo, getUserInfo } from "@/lib/codeforces/client";
import { CfError } from "@/lib/codeforces/types";
import { getChefProfile } from "@/lib/codechef/client";
import { getAtcoderProfile } from "@/lib/atcoder/client";
import { getLeetcodeProfile, leetcodeSolvedColumns } from "@/lib/leetcode/client";

type Admin = ReturnType<typeof createAdminClient>;

export type SyncPlatform = "codeforces" | "codechef" | "atcoder" | "leetcode";

// Rate-limit posture, by design:
//   codeforces — bulk user.info (≤250 handles per call) through the client's
//                global throttle; a 300-member slice per tick.
//   others     — 12 members per tick with 700ms spacing (≈1 req/s to each
//                site, one platform per scheduled day). Gentle by construction.
const CF_SLICE = 300;
const CF_BULK = 250;
const SCRAPE_SLICE = 12;
const SCRAPE_GAP_MS = 700;
const STALE_CLAIM_MIN = 5;

/**
 * How many minutes after a schedule's IST time a tick may still start its run.
 * Must exceed the cron poll interval (currently every 10 min) so a coarse tick
 * never steps over a scheduled minute like 03:07; the 20h dedup keeps an
 * over-wide window from starting twice. Also why a schedule must sit at least
 * this far before IST midnight (enforced in the schedule edit route): the
 * day-of-week rolls over at midnight and would drop out of the match.
 */
export const RATING_MATCH_WINDOW_MIN = 12;

const HANDLE_COL: Record<SyncPlatform, string> = {
  codeforces: "cf_handle",
  codechef: "codechef_handle",
  atcoder: "atcoder_handle",
  leetcode: "leetcode_handle",
};

/** Scrape/GraphQL platforms — the ones we auto-unlink on repeated not-found. */
type ScrapePlatform = "codechef" | "atcoder" | "leetcode";
const FAIL_COUNT_COL: Record<ScrapePlatform, string> = {
  codechef: "codechef_fail_count",
  atcoder: "atcoder_fail_count",
  leetcode: "leetcode_fail_count",
};
/** Consecutive definitive HANDLE_NOT_FOUND results before the handle is nulled. */
/**
 * Consecutive definitive "no such user" results before a handle is unlinked.
 *
 * Raised 2 -> 3 after the CodeChef incident. These platforms sync WEEKLY, so 3
 * is three separate weeks of the same answer, and unlinking forces the member
 * to re-verify from scratch — a cost we should only impose on real evidence.
 *
 * The streak is necessary but no longer sufficient: reaching it triggers a live
 * re-check (confirmHandleGone) and the handle survives unless that agrees. A
 * member who changed nothing therefore cannot be unlinked by stale strikes.
 */
const FAIL_THRESHOLD = 3;

/**
 * Time to reserve before starting another scrape item, per platform.
 *
 * The cron route is maxDuration = 60s. CodeChef's client throttle is 6s per
 * fetch (measured; see lib/codechef/client.ts), so a full SCRAPE_SLICE of 12
 * needs ~90s and the tick was being killed mid-slice — leaving items stranded
 * in `working` until the 5-minute stale-claim requeue, which is why runs
 * crawled. We now stop claiming new work when the remaining budget is under one
 * item's worth and hand the rest back as `queued` for the next tick.
 */
const SCRAPE_ITEM_RESERVE_MS: Record<ScrapePlatform, number> = {
  codechef: 9_000, // 6s throttle + request + inter-item gap
  atcoder: 3_000,
  leetcode: 3_000,
};

/** Whole-tick budget, leaving headroom for the counter refresh after draining. */
const TICK_BUDGET_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

/** IST wall-clock: day-of-week (0=Sunday) + "HH:MM". */
export function istNow(): { dow: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  let hour = get("hour");
  if (hour === "24") hour = "00"; // some ICU builds emit 24:xx
  return { dow: dowMap[get("weekday")] ?? 0, hhmm: `${hour}:${get("minute")}` };
}

/** "HH:MM" → minutes since IST midnight (0..1439). */
function hhmmToMin(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Start a sync run for a platform: snapshot every linked member into the queue.
 * Refuses when a run for the platform is already running.
 */
export async function startRun(
  admin: Admin,
  platform: SyncPlatform,
  trigger: "manual" | "scheduled"
): Promise<{ runId?: string; total?: number; error?: string }> {
  const { data: running } = await admin
    .from("rating_syncs")
    .select("id")
    .eq("platform", platform)
    .eq("status", "running")
    .limit(1);
  if (running && running.length > 0) {
    return { error: "already_running" };
  }

  const col = HANDLE_COL[platform];
  let query = admin
    .from("profiles")
    .select(`id, ${col}`)
    .not(col, "is", null)
    .eq("is_master", false)
    .eq("is_disabled", false);
  // CF ratings only make sense for verified handles
  if (platform === "codeforces") {
    query = query.eq("verification_status", "verified");
  }
  const { data: members } = await query.returns<Record<string, string>[]>();
  const items = (members ?? [])
    .map((m) => ({ userId: m.id, handle: m[col] }))
    .filter((m) => !!m.handle);

  const { data: run, error: runErr } = await admin
    .from("rating_syncs")
    .insert({ platform, trigger, total: items.length })
    .select("id")
    .single();
  if (runErr || !run) return { error: "could_not_start" };

  const rows = items.map((m) => ({
    run_id: run.id as string,
    user_id: m.userId,
    handle: m.handle,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await admin.from("rating_sync_queue").insert(rows.slice(i, i + 500));
  }

  // an empty platform finishes immediately
  if (items.length === 0) {
    await admin
      .from("rating_syncs")
      .update({ status: "done", finished_at: now() })
      .eq("id", run.id);
  }
  return { runId: run.id as string, total: items.length };
}

/** Map a fetched profile onto the member's rating columns. */
async function writeProfile(
  admin: Admin,
  platform: SyncPlatform,
  userId: string,
  handle: string
): Promise<void> {
  if (platform === "codechef") {
    const p = await getChefProfile(handle);
    await admin
      .from("profiles")
      .update({
        codechef_rating: p.rating,
        codechef_max_rating: p.maxRating,
        codechef_stars: p.stars,
        codechef_synced_at: now(),
        codechef_fail_count: 0, // a good sync clears the not-found streak
      })
      .eq("id", userId);
    // solved count (0100) in its own write, so a database without that
    // column yet still gets the rating above
    if (p.solved != null) {
      const { error } = await admin
        .from("profiles")
        .update({ codechef_solved: p.solved })
        .eq("id", userId);
      if (error && error.code !== "42703") console.error("codechef solved:", error);
    }
  } else if (platform === "atcoder") {
    const p = await getAtcoderProfile(handle);
    await admin
      .from("profiles")
      .update({
        atcoder_rating: p.rating,
        atcoder_max_rating: p.maxRating,
        atcoder_rank: p.rank,
        atcoder_synced_at: now(),
        atcoder_fail_count: 0, // a good sync clears the not-found streak
      })
      .eq("id", userId);
  } else if (platform === "leetcode") {
    const p = await getLeetcodeProfile(handle);
    await admin
      .from("profiles")
      .update({
        leetcode_rating: p.rating,
        leetcode_global_rank: p.globalRank,
        leetcode_top_pct: p.topPct,
        leetcode_synced_at: now(),
        leetcode_fail_count: 0, // a good sync clears the not-found streak
      })
      .eq("id", userId);
    // solved counts (0099) in their own write, so a database without those
    // columns yet still gets the rating above
    const solved = leetcodeSolvedColumns(p);
    if (solved) {
      const { error } = await admin.from("profiles").update(solved).eq("id", userId);
      if (error && error.code !== "42703") console.error("leetcode solved:", error);
    }
  }
}

type QueueItem = { id: string; user_id: string; handle: string };

/** Atomically claim up to `n` queued items of a run (conditional UPDATE). */
async function claim(
  admin: Admin,
  runId: string,
  n: number
): Promise<QueueItem[]> {
  const { data: candidates } = await admin
    .from("rating_sync_queue")
    .select("id")
    .eq("run_id", runId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(n);
  if (!candidates || candidates.length === 0) return [];
  const { data: claimed } = await admin
    .from("rating_sync_queue")
    .update({ status: "working", claimed_at: now() })
    .in(
      "id",
      candidates.map((c) => c.id as string)
    )
    .eq("status", "queued") // only wins the race for still-queued rows
    .select("id, user_id, handle");
  return (claimed ?? []) as QueueItem[];
}

/** Hand claimed-but-unprocessed items back so the next tick picks them up. */
async function release(admin: Admin, itemIds: string[]) {
  if (itemIds.length === 0) return;
  await admin
    .from("rating_sync_queue")
    .update({ status: "queued", claimed_at: null })
    .in("id", itemIds);
}

async function finish(admin: Admin, itemId: string, error?: string) {
  await admin
    .from("rating_sync_queue")
    .update(
      error
        ? { status: "error", error: error.slice(0, 200) }
        : { status: "done" }
    )
    .eq("id", itemId);
}

/** Codeforces: bulk user.info; isolates unknown handles via single lookups. */
async function processCf(admin: Admin, items: QueueItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += CF_BULK) {
    const batch = items.slice(i, i + CF_BULK);
    try {
      const users = await getUsersInfo(batch.map((b) => b.handle));
      const byHandle = new Map(users.map((u) => [u.handle.toLowerCase(), u]));
      for (const item of batch) {
        const u = byHandle.get(item.handle.toLowerCase());
        if (!u) {
          await finish(admin, item.id, "missing from CF response");
          continue;
        }
        await admin
          .from("profiles")
          .update({
            cf_rating: u.rating ?? null,
            cf_max_rating: u.maxRating ?? null,
            cf_rank: u.rank ?? null,
            cf_last_synced_at: now(),
          })
          .eq("id", item.user_id);
        await finish(admin, item.id);
      }
    } catch (e) {
      if (e instanceof CfError && e.kind === "HANDLE_NOT_FOUND") {
        // one bad handle fails the whole bulk call — isolate one by one
        for (const item of batch) {
          try {
            const u = await getUserInfo(item.handle);
            await admin
              .from("profiles")
              .update({
                cf_rating: u.rating ?? null,
                cf_max_rating: u.maxRating ?? null,
                cf_rank: u.rank ?? null,
                cf_last_synced_at: now(),
              })
              .eq("id", item.user_id);
            await finish(admin, item.id);
          } catch (single) {
            await finish(
              admin,
              item.id,
              single instanceof Error ? single.message : "lookup failed"
            );
          }
        }
      } else {
        // CF down / rate limited: release the claims, retry next tick
        await admin
          .from("rating_sync_queue")
          .update({ status: "queued", claimed_at: null })
          .in(
            "id",
            batch.map((b) => b.id)
          )
          .eq("status", "working");
      }
    }
  }
}

/**
 * A scrape handle came back DEFINITIVELY not-found. Bump its consecutive-fail
 * counter; once it reaches FAIL_THRESHOLD, null the handle so the member is
 * prompted to re-verify, and reset the counter. Buffered (2 strikes) because
 * CodeChef scraping is flaky — a single blip must not unlink a real account.
 *
 * Only the profile's own handle + counter are touched. Event registrations,
 * intake applications, attendance, and stored leaderboard rows are separate
 * records keyed on user_id and are never affected — losing the handle only
 * changes the fully-verified seal + live standings from here on.
 */
/**
 * Fetch the profile one more time, right now, and say what we actually saw.
 *
 * Reaching FAIL_THRESHOLD means three past runs said "gone" — but those runs
 * are days old and were produced by the same scraper that once misread
 * Cloudflare 403s as "no such user". Before doing something destructive we ask
 * the platform again and require it to agree.
 *
 *   "gone"    — a definitive HANDLE_NOT_FOUND: 404, or a bounce off /users
 *   "alive"   — the profile loaded: the member changed nothing, do not touch
 *   "unknown" — DOWN / rate-limited / malformed: no evidence, so do nothing
 */
async function confirmHandleGone(
  platform: ScrapePlatform,
  handle: string
): Promise<"gone" | "alive" | "unknown"> {
  try {
    if (platform === "codechef") await getChefProfile(handle);
    else if (platform === "atcoder") await getAtcoderProfile(handle);
    else await getLeetcodeProfile(handle);
    return "alive";
  } catch (e) {
    const kind =
      e && typeof e === "object" && "kind" in e
        ? (e as { kind: unknown }).kind
        : null;
    return kind === "HANDLE_NOT_FOUND" ? "gone" : "unknown";
  }
}

async function markHandleNotFound(
  admin: Admin,
  platform: ScrapePlatform,
  userId: string,
  handle: string
): Promise<void> {
  const col = FAIL_COUNT_COL[platform];
  const { data: prof } = await admin
    .from("profiles")
    .select(col)
    .eq("id", userId)
    .single();
  const next = ((prof as Record<string, number | null> | null)?.[col] ?? 0) + 1;
  if (next < FAIL_THRESHOLD) {
    await admin.from("profiles").update({ [col]: next }).eq("id", userId);
    return;
  }

  // At the threshold: never unlink on the strength of the streak alone.
  const verdict = await confirmHandleGone(platform, handle);
  if (verdict === "alive") {
    // The account is fine — the streak was our own false negatives. Clear it.
    await admin.from("profiles").update({ [col]: 0 }).eq("id", userId);
    return;
  }
  if (verdict === "unknown") {
    // No evidence either way. Hold the streak at the threshold and try again
    // next run rather than guessing.
    await admin.from("profiles").update({ [col]: next }).eq("id", userId);
    return;
  }
  await admin
    .from("profiles")
    .update({ [HANDLE_COL[platform]]: null, [col]: 0 })
    .eq("id", userId);
}

/** Scrape/GraphQL platforms: small batch, fixed spacing between requests. */
async function processScrape(
  admin: Admin,
  platform: SyncPlatform,
  items: QueueItem[],
  deadline: number
): Promise<number> {
  const reserve = SCRAPE_ITEM_RESERVE_MS[platform as ScrapePlatform] ?? 3_000;
  let processed = 0;
  for (const [i, item] of items.entries()) {
    // Stop before starting work we cannot finish: an item interrupted by the
    // function timing out stays `working` and blocks for STALE_CLAIM_MIN.
    if (Date.now() + reserve > deadline) {
      await release(admin, items.slice(i).map((r) => r.id));
      break;
    }
    try {
      await writeProfile(admin, platform, item.user_id, item.handle);
      await finish(admin, item.id);
    } catch (e) {
      // A definitive "no such user" counts toward auto-unlinking the handle;
      // transient errors (DOWN / BAD_RESPONSE) never do.
      if (
        platform !== "codeforces" &&
        e &&
        typeof e === "object" &&
        "kind" in e &&
        (e as { kind: unknown }).kind === "HANDLE_NOT_FOUND"
      ) {
        await markHandleNotFound(admin, platform, item.user_id, item.handle);
      }
      await finish(admin, item.id, e instanceof Error ? e.message : "failed");
    }
    processed += 1;
    await sleep(SCRAPE_GAP_MS);
  }
  return processed;
}

/**
 * One cron tick: requeue stale claims, start any due scheduled runs (IST
 * day+time match, once per day), then drain every running run within budget.
 */
export async function processTick(admin: Admin): Promise<{
  started: string[];
  drained: Record<string, number>;
}> {
  const deadline = Date.now() + TICK_BUDGET_MS;
  const started: string[] = [];
  const drained: Record<string, number> = {};

  // 1. requeue claims stuck by a crashed tick
  await admin
    .from("rating_sync_queue")
    .update({ status: "queued", claimed_at: null })
    .eq("status", "working")
    .lt("claimed_at", new Date(Date.now() - STALE_CLAIM_MIN * 60_000).toISOString());

  // 2. start scheduled runs whose IST day+time has arrived (dedup: one start
  //    per 20h). The cron polls every 10 min, so we match a WINDOW after the
  //    scheduled minute rather than the exact minute — an exact-minute match
  //    would let a coarse tick step over e.g. 03:07 and the run would never
  //    fire. The 20h dedup below still guarantees exactly one start.
  const { dow, hhmm } = istNow();
  const nowMin = hhmmToMin(hhmm);
  const { data: schedules } = await admin
    .from("sync_schedules")
    .select("platform, day_of_week, time_ist, enabled");
  for (const s of schedules ?? []) {
    if (!s.enabled || s.day_of_week !== dow) continue;
    // fire once the scheduled minute has passed, within the poll window
    const delta = nowMin - hhmmToMin(s.time_ist as string);
    if (delta < 0 || delta >= RATING_MATCH_WINDOW_MIN) continue;
    const platform = s.platform as SyncPlatform;
    const { data: recent } = await admin
      .from("rating_syncs")
      .select("id")
      .eq("platform", platform)
      .gte("started_at", new Date(Date.now() - 20 * 3600_000).toISOString())
      .limit(1);
    if (recent && recent.length > 0) continue;
    const res = await startRun(admin, platform, "scheduled");
    if (res.runId) started.push(platform);
  }

  // 3. drain running runs
  const { data: runs } = await admin
    .from("rating_syncs")
    .select("id, platform")
    .eq("status", "running")
    .order("started_at", { ascending: true });

  for (const run of runs ?? []) {
    const platform = run.platform as SyncPlatform;
    const runId = run.id as string;
    const items = await claim(
      admin,
      runId,
      platform === "codeforces" ? CF_SLICE : SCRAPE_SLICE
    );
    if (items.length > 0) {
      let ran = items.length;
      if (platform === "codeforces") await processCf(admin, items);
      else ran = await processScrape(admin, platform, items, deadline);
      drained[platform] = (drained[platform] ?? 0) + ran;
    }

    // refresh counters from queue truth; finalize when nothing is left
    const count = async (status: string) => {
      const { count: c } = await admin
        .from("rating_sync_queue")
        .select("id", { count: "exact", head: true })
        .eq("run_id", runId)
        .eq("status", status);
      return c ?? 0;
    };
    const [done, errored, queued, working] = await Promise.all([
      count("done"),
      count("error"),
      count("queued"),
      count("working"),
    ]);
    const finished = queued === 0 && working === 0;
    const { data: lastErr } = errored
      ? await admin
          .from("rating_sync_queue")
          .select("error")
          .eq("run_id", runId)
          .eq("status", "error")
          .order("created_at", { ascending: false })
          .limit(1)
      : { data: null };
    await admin
      .from("rating_syncs")
      .update({
        processed: done + errored,
        updated: done,
        failed: errored,
        ...(errored ? { last_error: lastErr?.[0]?.error ?? null } : {}),
        ...(finished ? { status: "done", finished_at: now() } : {}),
      })
      .eq("id", runId);
  }

  return { started, drained };
}

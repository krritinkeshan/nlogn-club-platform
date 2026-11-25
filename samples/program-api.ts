import "server-only";

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { managesProgram } from "@/lib/cohorts/program-managers";

/**
 * Admins-only gate for the program routes managers can't use: creating a
 * program and choosing its managers (edits use programEditor). Signed in and
 * an admin (RLS limits the writes to admins too). Returns the user-scoped
 * client, or the response to send back.
 */
export async function programAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Not signed in" }, { status: 401 }),
    } as const;
  }
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin, is_master")
    .eq("id", user.id)
    .single();
  if (!me?.is_admin && !me?.is_master) {
    return {
      error: NextResponse.json({ error: "Admins only" }, { status: 403 }),
    } as const;
  }
  return { supabase, user } as const;
}

/** What an edit touches: a program, or a section or item inside one. */
export type ProgramTarget =
  | { programId: string }
  | { sectionId: string }
  | { itemId: string };

/**
 * Gate for editing one program: renaming or deleting it, its sections, its
 * items. Admins and masters as before, writing through their own client (RLS
 * checks them again), or one of that program's managers (0104), checked on
 * every call: still a member of its cohort, an ordinary account. A manager's
 * writes go through the service client, because the program tables only let
 * admins write; this check is their rights check.
 * Creating a program and choosing managers stay admin-only (programAdmin).
 */
export async function programEditor(target: ProgramTarget) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Not signed in" }, { status: 401 }),
    } as const;
  }
  const { data: me } = await supabase
    .from("profiles")
    .select("is_admin, is_master")
    .eq("id", user.id)
    .single();
  if (me?.is_admin || me?.is_master) {
    return { db: supabase as SupabaseClient, user } as const;
  }

  const admin = createAdminClient();
  const programId = await programOf(admin, target);
  if (programId && (await managesProgram(admin, user.id, programId))) {
    return { db: admin as SupabaseClient, user } as const;
  }
  return {
    error: NextResponse.json(
      { error: "Only admins and this program's managers can edit it" },
      { status: 403 }
    ),
  } as const;
}

/** The program an edit lands in (null when the section or item is gone). */
async function programOf(
  db: SupabaseClient,
  target: ProgramTarget
): Promise<string | null> {
  if ("programId" in target) return target.programId;
  let sectionId: string | null = null;
  if ("sectionId" in target) {
    sectionId = target.sectionId;
  } else {
    const { data: item } = await db
      .from("cohort_program_items")
      .select("section_id")
      .eq("id", target.itemId)
      .maybeSingle<{ section_id: string }>();
    sectionId = item?.section_id ?? null;
  }
  if (!sectionId) return null;
  const { data: section } = await db
    .from("cohort_program_sections")
    .select("program_id")
    .eq("id", sectionId)
    .maybeSingle<{ program_id: string }>();
  return section?.program_id ?? null;
}

/** The position after the last row under `parent` (new rows go at the end). */
export async function nextPosition(
  supabase: SupabaseClient,
  table: string,
  parentColumn: string,
  parentId: string
): Promise<number> {
  const { data } = await supabase
    .from(table)
    .select("position")
    .eq(parentColumn, parentId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.position as number | undefined) ?? -1) + 1;
}

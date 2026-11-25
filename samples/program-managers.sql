-- Program managers.
--
-- An admin can let ordinary members of a cohort edit one of its programs:
-- its sections, problems and links, its name, or delete it. They do it from
-- their own My Cohorts page (Manage -> Programs).
--
-- The program tables' write rules stay admins-only. A manager's edits go
-- through the site's API, which checks this table on every edit (still a
-- member of the cohort, not a visitor, master or disabled account) and only
-- then writes with the service key. So a manager can never write to the
-- program tables directly, only through the API's checks and input rules.

create table public.cohort_program_managers (
  program_id uuid not null references public.cohort_programs(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (program_id, user_id)
);

create index cohort_program_managers_user_idx
  on public.cohort_program_managers (user_id);

alter table public.cohort_program_managers enable row level security;

-- Admins see and change everything; a manager sees their own rows (their
-- sidebar reads them to show Manage).
create policy cohort_program_managers_select on public.cohort_program_managers
  for select using (public.is_admin() or user_id = auth.uid());
create policy cohort_program_managers_write on public.cohort_program_managers
  for all using (public.is_admin()) with check (public.is_admin());

-- This schema has no default table grants: every new table needs them.
grant select, insert, update, delete on public.cohort_program_managers to authenticated;

-- Leaving a cohort ends managing its programs. The API checks membership on
-- every edit anyway; this keeps a later re-join from quietly bringing the
-- rights back. Security definer so it works whoever removes the member.
create or replace function public.drop_program_managers_on_leave()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.cohort_program_managers m
  using public.cohort_programs p
  where p.id = m.program_id
    and p.cohort_id = old.cohort_id
    and m.user_id = old.user_id;
  return null;
end;
$$;

create trigger cohort_members_drop_program_managers
  after delete on public.cohort_members
  for each row execute function public.drop_program_managers_on_leave();

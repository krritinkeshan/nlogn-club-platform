# Architecture

How the NlogN club platform fits together. The diagrams are written in Mermaid, so GitHub draws them.

## 1. The big picture

```mermaid
flowchart TB
  subgraph Users
    M[Members]
    A[Admins]
    F[Faculty, read-only]
  end

  subgraph AWS [AWS EC2, Mumbai]
    C[Caddy: HTTPS]
    N[Next.js 16 server]
    C --> N
  end

  subgraph Supabase [Supabase, Mumbai]
    DB[(Postgres + row level security)]
    AU[Google sign-in]
    CR[pg_cron jobs]
    ST[File storage]
  end

  subgraph Judges
    CF[Codeforces API]
    AC[AtCoder]
    CC[CodeChef]
    LC[LeetCode]
    CS[CSES]
  end

  Users -->|HTTPS| C
  N <--> DB
  N <--> AU
  N --> ST
  CR -->|calls /api/cron/* every minute| N
  N -->|ratings, solves, standings| Judges
```

- **One server, one database, same city.** The app and the database both sit in Mumbai, so every query is a short hop.
- **The database does the scheduling.** `pg_cron` calls the app's cron endpoints, and the app does the actual work.
- **Judges are read-only.** The site never submits or judges code. It only reads public data.

## 2. A page load and a write

Pages read data with the member's own login token, so Postgres row level security decides what they see. Writes always go through an API route that checks the member's rights again.

```mermaid
sequenceDiagram
  participant B as Browser
  participant P as proxy.ts
  participant S as Page (server component)
  participant R as API route
  participant D as Postgres

  B->>P: GET /events
  P->>P: Verify login token locally (no network call)
  P->>S: Render
  S->>D: Query with the member's token
  D-->>S: Only rows RLS allows
  S-->>B: HTML

  B->>R: POST /api/events/{id}/register
  R->>D: Who is this? (full session check)
  R->>D: register_for_event() runs inside the database
  D-->>R: ok, or a reason (window closed, wrong cohort, visitor...)
  R-->>B: Result
```

Registration, teams and cancellations are Postgres functions. Two people can't both take the last seat, and the rules hold even if someone calls the database directly.

## 3. Proving account ownership

No judge offers a sign-in the site could use, so each one has its own proof. None of them ask for a password.

**Codeforces:** submit a compile error to a problem the site picks.

```mermaid
sequenceDiagram
  participant M as Member
  participant W as Site
  participant CF as Codeforces API

  M->>W: Link handle "tourist"
  W->>W: Pick a random problem, start a timer
  W-->>M: Submit a compile error to problem X
  M->>CF: Submits on codeforces.com
  M->>W: Check
  W->>CF: Latest submissions of "tourist"
  CF-->>W: COMPILATION_ERROR on X, after the start time
  W->>W: Handle verified, rating saved
```

**CodeChef, AtCoder, LeetCode:** the site gives a one-time code, the member puts it in a profile field, and the site reads it back.

**CSES** has no API and no profile field. The site uses the colour of the member's task grid instead:

```mermaid
sequenceDiagram
  participant M as Member
  participant W as Site
  participant CS as cses.fi

  M->>W: My profile link
  W->>CS: Read the public profile
  W-->>M: Is this you? (shows the name)
  W->>CS: Read their task grid
  W-->>M: Submit anything to task T (one they never opened)
  M->>CS: Submits
  M->>W: Check
  W->>CS: Read the grid again
  CS-->>W: Task T is no longer blank
  W->>W: Linked, and every solved task imported
```

Attempts are capped at three an hour. All requests to CSES go one at a time, 1.2 seconds apart.

## 4. The rating sync queue

Codeforces allows a bulk lookup of 250 handles per call. CodeChef, AtCoder and LeetCode are read about once a second. Every cron tick also has a hard time limit. So a sync is a queue that many short ticks work through.

```mermaid
flowchart TD
  T[pg_cron tick, every minute] --> D{A platform's scheduled<br/>time has come?}
  D -->|yes| S[Start a run: put every<br/>linked member in the queue]
  D -->|no| W
  S --> W[Claim a small batch<br/>queued to working, in one atomic update]
  W --> K{Which platform?}
  K -->|Codeforces| B[One bulk call for up to 250 handles]
  K -->|Others| O[One member at a time, about 1 per second]
  B --> R[Save rating, max, rank]
  O --> R
  R --> L{Time budget left?}
  L -->|yes| W
  L -->|no| H[Hand unfinished items back as queued]
  H --> E[Next tick carries on]
  X[Claimed more than 5 minutes ago] -.->|requeued| W
```

Safety rules:
- **Errors never wipe data.** A failed lookup leaves the old rating in place.
- **No unlinking on one bad answer.** A handle is unlinked only after three separate "not found" results, and only if a live re-check agrees.
- **Outages pause the run.** If a judge is down, its items go back in the queue for later.

Solved problems sync the same way, with their own schedule for each platform. CSES runs at 10 pm every night.

## 5. Data model (main tables)

```mermaid
erDiagram
  profiles ||--o{ event_registrations : registers
  profiles ||--o{ event_attendance : "is marked"
  profiles ||--o{ event_feedback : gives
  profiles ||--o{ solve_log : solved
  profiles ||--o{ cohort_members : joins
  profiles ||--o{ cohort_program_managers : manages

  events ||--o{ event_registrations : has
  events ||--o{ event_teams : has
  event_teams ||--o{ event_registrations : groups
  events ||--o{ event_attendance : has
  events ||--o{ event_feedback : collects
  events ||--o{ event_cohorts : "limited to"
  events ||--o{ event_standings : "frozen results"

  cohorts ||--o{ cohort_members : has
  cohorts ||--o{ event_cohorts : scopes
  cohorts ||--o{ cohort_programs : runs
  cohort_programs ||--o{ cohort_program_sections : "weeks and resources"
  cohort_program_sections ||--o{ cohort_program_items : "problems and links"
  cohort_programs ||--o{ cohort_program_managers : "edited by"

  ladders ||--o{ ladder_problems : contains

  rating_syncs ||--o{ rating_sync_queue : "work items"
```

Rules every table follows:
- **Row level security is always on.** Every table has explicit grants. The schema has no default access, so a new table is closed until it says otherwise.
- **Role columns are protected.** `is_admin`, `is_master` and `is_visitor` are guarded by a trigger, so nobody can promote themselves.
- **Times are stored in UTC** and shown in Indian time.
- **Public addresses use short numbers**, like `/events/100002` and `/cohorts/ch1003/programs/pg1001`. The internal ids never show.

## 6. Roles

| Role | Who | Can do |
|---|---|---|
| Member | Students with a college account | Link accounts, register, train, appear on leaderboards |
| Admin | Club leads | Everything a member can, plus run events, attendance, cohorts and programs |
| Program manager | A member an admin picks | Edit one training program in their own cohort |
| Visitor | Faculty | Read only, never on leaderboards |
| Master | The operator | System pages (access, syncs, maintenance), never takes part |

## 7. Shipping changes

```mermaid
flowchart LR
  P[git push to main] --> G[GitHub Actions]
  G --> B[next build<br/>standalone bundle]
  B --> R[rsync to the server]
  R --> S[systemctl restart]
  S --> C[Caddy retries for up to 10 s,<br/>so visitors don't see errors]
```

The server itself is defined in Terraform: the instance, its fixed IP, the firewall, and two budget alerts (one for real charges, one for usage). Building happens on GitHub, never on the 2 GB server.

## 8. Keeping it fast

- **Login check on the server.** The login token is verified locally with the project's public key, instead of a network call on every page. That removed about a quarter of all database API traffic.
- **Links preload on intent.** A link loads its page when you hover or tap it, not as soon as it's on screen.
- **Counts are computed in SQL.** Things like "how many people solved this" never fetch thousands of rows.
- **The server is sized from real usage:** about 0.5% average CPU, under 1 GB of memory and 0.3 GB of traffic a day.

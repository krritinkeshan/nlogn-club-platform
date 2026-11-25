// Parse a Codeforces contest URL into what the API needs. Handles regular
// contests, gyms, the /contests/<id> listing page, and private group mashups
// (/group/<slug>/contest/<id>). `asManager` = group links, which require the
// manager-signed API. `base` is the path problem links hang off, preserved
// exactly (so group-mashup problem links keep the group slug).
export function parseContestUrl(
  raw: string
): { contestId: number; asManager: boolean; base: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.hostname.toLowerCase().includes("codeforces.com")) return null;

  const m = u.pathname.match(/\/(contests|contest|gym)\/(\d+)/);
  if (!m) return null;

  const contestId = Number(m[2]);
  const asManager = u.pathname.includes("/group/");
  const base =
    m[1] === "contests"
      ? `${u.origin}/${contestId > 100000 ? "gym" : "contest"}/${contestId}`
      : `${u.origin}${u.pathname.slice(0, m.index! + m[0].length)}`;

  return { contestId, asManager, base };
}

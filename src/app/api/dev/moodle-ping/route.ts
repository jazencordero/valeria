import { connection } from "next/server";

// M0-06: does MyCourses answer calls from our hosting? No key, no-login call only.
// Region is pinned to fra1 for the whole project in vercel.json (`regions`);
// Next's `preferredRegion` export is deprecated and Vercel rejects region codes there.

const SITE = "https://mycourses.aalto.fi";
const TIMEOUT_MS = 10_000;

export async function GET() {
  await connection(); // always run at request time, never prerender

  // A test tool for preview links only. On the live site anyone could use it
  // to make our server call MyCourses over and over, outside the client's limits.
  if (process.env.VERCEL_ENV === "production") return new Response(null, { status: 404 });

  const started = performance.now();
  const region = process.env.VERCEL_REGION ?? "local";
  try {
    const res = await fetch(
      `${SITE}/lib/ajax/service-nologin.php?info=tool_mobile_get_public_config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      },
    );
    const ms = Math.round(performance.now() - started);
    const text = await res.text();
    let typeoflogin: number | null = null;
    let error: string | null = null;
    try {
      const body = JSON.parse(text);
      const first = Array.isArray(body) ? body[0] : null;
      if (first?.error) error = first.exception?.errorcode ?? "moodle_error";
      typeoflogin = first?.data?.typeoflogin ?? null;
    } catch {
      error = "not_json"; // a firewall block page usually lands here
    }
    return Response.json({ ok: res.ok && error === null && typeoflogin !== null, status: res.status, typeoflogin, ms, region, error });
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    const error = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network";
    return Response.json({ ok: false, status: null, typeoflogin: null, ms, region, error });
  }
}

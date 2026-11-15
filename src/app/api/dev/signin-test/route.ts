import { createHash } from "node:crypto";
import { allowedSiteUrls } from "@/lib/schools";
import { callMoodle, MoodleError } from "@/server/moodle/client";
import { exchangeQrKey, parseQr } from "@/server/moodle/qr";
import { allow } from "@/server/throttle";

/*
 * Dev-only sign-in test (preview links only, behind Vercel login): does
 * MyCourses swap a QR key for a token when the swap comes from our server?
 * Moodle's `qrsameipcheck` may refuse it with `ipmismatch`, because the QR was
 * shown on her device and the swap comes from Vercel's address.
 *
 * Why not `connectWithQr` / `connectWithKey`: those seal and store the token in
 * the database. This test must store nothing. It swaps the key exactly as
 * qr.ts does (`exchangeQrKey`: service-nologin.php, "MoodleMobile" in the
 * User-Agent), calls core_webservice_get_site_info once to prove the token
 * works, then drops the token. The token, the private token and the QR key are
 * never logged, stored or returned; Moodle's message is scrubbed of both just
 * in case. `callMoodle` gets no userId, so its daily count stays in memory
 * (no database write).
 *
 * Brake (M1-43): `allow` with no userId counts in this instance's memory,
 * keyed by a hash of the visitor's session cookie (else the forwarded IP).
 * On serverless that is a weak brake, which is fine for a two-person test.
 *
 * Response, always: { ok, errorcode, message, ms, serverRegion, site }.
 */

const TRIES_PER_MINUTE = 5;
const TRIES_PER_DAY = 30;

type Answer = {
  ok: boolean;
  errorcode: string | null;
  message: string | null;
  ms: number;
  serverRegion: string;
  site: { userIdPresent: true; functions: number } | null;
};

function visitorKey(request: Request): string {
  const cookie = /(?:^|;\s*)ready_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
  return createHash("sha256").update(cookie ? `c:${cookie}` : `ip:${ip}`).digest("hex").slice(0, 32);
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV === "production") return new Response(null, { status: 404 });

  const started = performance.now();
  const reply = (a: Omit<Answer, "ms" | "serverRegion">) =>
    Response.json(
      { ...a, ms: Math.round(performance.now() - started), serverRegion: process.env.VERCEL_REGION ?? "local" } satisfies Answer,
      { headers: { "cache-control": "no-store" } },
    );

  let text = "";
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body?.text === "string" ? body.text : "";
  } catch {
    return reply({ ok: false, errorcode: "bad_request", message: "Send JSON {text}.", site: null });
  }

  const qr = parseQr(text);
  if (!qr) return reply({ ok: false, errorcode: "not_a_qr", message: "That text is not a MyCourses QR link.", site: null });
  const site = allowedSiteUrls().find((s) => s === qr.site);
  if (!site) return reply({ ok: false, errorcode: "site_not_allowed", message: "That site is not in our schools list.", site: null });

  const who = visitorKey(request);
  const allowed =
    (await allow(`dev-signin-test:${who}:minute`, { max: TRIES_PER_MINUTE, perSeconds: 60 })) &&
    (await allow(`dev-signin-test:${who}:day`, { max: TRIES_PER_DAY, perSeconds: 24 * 60 * 60 }));
  if (!allowed) return reply({ ok: false, errorcode: "too_many", message: "Too many tries. Wait a minute.", site: null });

  if (process.env.MOODLE_FAKE === "1") {
    return reply({ ok: false, errorcode: "moodle_fake_on", message: "MOODLE_FAKE=1 is set; this test needs the real MyCourses.", site: null });
  }

  const scrub = (s: string, secrets: (string | null)[]) =>
    secrets.reduce<string>((out, x) => (x ? out.split(x).join("[hidden]") : out), s);

  let token: string | null = null;
  try {
    try {
      token = await exchangeQrKey(site, qr.key, qr.userid, 15_000);
    } catch (err) {
      const e = err instanceof MoodleError ? err : null;
      return reply({
        ok: false,
        errorcode: e?.errorcode ?? "unknown",
        message: scrub(`swap: ${e?.message ?? "failed"}`, [qr.key]),
        site: null,
      });
    }
    try {
      const info = await callMoodle<{ userid?: unknown; functions?: unknown[] }>(
        { siteUrl: site, token },
        "core_webservice_get_site_info",
      );
      const functions = Array.isArray(info?.functions) ? info.functions.length : 0;
      if (typeof info?.userid !== "number") {
        return reply({ ok: false, errorcode: "no_userid", message: "site info: answer had no user id", site: null });
      }
      return reply({ ok: true, errorcode: null, message: null, site: { userIdPresent: true, functions } });
    } catch (err) {
      const e = err instanceof MoodleError ? err : null;
      return reply({
        ok: false,
        errorcode: e?.errorcode ?? "unknown",
        message: scrub(`site info: ${e?.message ?? "failed"}`, [qr.key, token]),
        site: null,
      });
    }
  } finally {
    token = null; // drop it; it is never stored, logged or returned
  }
}

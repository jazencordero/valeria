// Helpers to get a Moodle mobile web service token without a password:
// the browser SSO launch flow and the QR login flow. Never logs tokens.

import { MoodleError } from "./ws.mjs";

function base(site) {
  return String(site).replace(/\/+$/, "");
}

/** URL that starts the mobile app SSO flow in a browser. */
export function launchUrl(site, passport, scheme = "moodlemobile") {
  const qs = new URLSearchParams({
    service: "moodle_mobile_app",
    passport: String(passport),
    urlscheme: scheme,
  });
  return `${base(site)}/admin/tool/mobile/launch.php?${qs}`;
}

/**
 * Decode the redirect launch.php sends at the end of SSO:
 * `scheme://token=BASE64`, where BASE64 decodes to
 * `signature:::token` or `signature:::token:::privatetoken`.
 */
export function decodeLaunchRedirect(url) {
  const match = /token=([^&#\s]+)/.exec(String(url));
  if (!match) throw new Error("Redirect has no token= part");
  const decoded = Buffer.from(decodeURIComponent(match[1]), "base64").toString("utf8");
  const parts = decoded.split(":::");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error("Redirect token is not signature:::token[:::privatetoken]");
  }
  return { signature: parts[0], token: parts[1], privatetoken: parts[2] || null };
}

/** Read `moodlemobile://https://site?qrlogin=KEY&userid=ID` into { site, key, userid }. */
export function parseQr(text) {
  const raw = String(text).trim().replace(/^moodlemobile:\/\//i, "");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("QR text is not a Moodle site link");
  }
  const key = u.searchParams.get("qrlogin");
  const userid = Number(u.searchParams.get("userid"));
  if (!key || !Number.isInteger(userid) || userid <= 0) {
    throw new Error("QR text has no qrlogin key or userid");
  }
  const site = base(`${u.origin}${u.pathname}`);
  return { site, key, userid };
}

/**
 * Swap a QR login key for a mobile web service token.
 *
 * Verified 2026-11-14 against moodle/moodle `main`:
 * - public/admin/tool/mobile/classes/external.php, get_tokens_for_qr_login_parameters():
 *   args are `qrloginkey` (PARAM_ALPHANUMEXT) and `userid` (PARAM_INT); returns
 *   { token, privatetoken, warnings }. The key is single-use (deleted after validation).
 * - public/admin/tool/mobile/db/services.php: `tool_mobile_get_tokens_for_qr_login` has
 *   ajax => true, loginrequired => false, so it is callable via lib/ajax/service-nologin.php.
 * - The function throws `apprequired` unless core_useragent::is_moodle_app(), which checks
 *   the User-Agent contains "MoodleMobile" (public/lib/classes/useragent.php). So we send one.
 *   It also throws `qrcodedisabled` unless the site's QR code type is "login" (type 2).
 * https://github.com/moodle/moodle/blob/main/public/admin/tool/mobile/classes/external.php
 *
 * Returns { token, privatetoken }.
 */
export async function exchangeQr(site, key, userid) {
  const fn = "tool_mobile_get_tokens_for_qr_login";
  const res = await fetch(`${base(site)}/lib/ajax/service-nologin.php?info=${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "MoodleMobile (ready-m0 test)" },
    body: JSON.stringify([{ index: 0, methodname: fn, args: { qrloginkey: String(key), userid: Number(userid) } }]),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MoodleError({ message: `QR login answered HTTP ${res.status} with non-JSON`, errorcode: "invalidresponse", status: res.status });
  }
  // service-nologin.php answers an array of { error, data | exception }, or a bare error object.
  const first = Array.isArray(body) ? body[0] : body;
  if (!first || first.error || first.exception || first.errorcode) {
    const ex = first?.exception && typeof first.exception === "object" ? first.exception : first || {};
    throw new MoodleError({
      message: ex.message,
      errorcode: ex.errorcode,
      exception: typeof ex.exception === "string" ? ex.exception : null,
      debuginfo: ex.debuginfo,
      status: res.status,
    });
  }
  const data = first.data;
  if (!data || !data.token) {
    throw new MoodleError({ message: "QR login answer had no token", errorcode: "invalidresponse", status: res.status });
  }
  return { token: data.token, privatetoken: data.privatetoken || null };
}

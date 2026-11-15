"use client";

import { useEffect, useState } from "react";
import { SCHOOLS } from "@/lib/schools";

const LMS = SCHOOLS.aalto.lms;

// Dev-only sign-in test, browser side. Test A posts the QR text to our server.
// Test B checks whether the Moodle launch link honours our own URL scheme
// `web+ready`. The token Moodle sends back in Test B is checked here and then
// dropped: never shown, stored or sent anywhere.

const SITE = "https://mycourses.aalto.fi";
const SCHEME = "web+ready";
const PASSPORT_KEY = "signin-test:passport";
const SUMMARY_A_KEY = "signin-test:summaryA";

type AnswerA = {
  ok: boolean;
  errorcode: string | null;
  message: string | null;
  ms: number;
  serverRegion: string;
  site: { userIdPresent: true; functions: number } | null;
};

type ResultB = { received: boolean; signatureMatches: boolean; privateToken: boolean };

// ---------------------------------------------------------------------------
// A small MD5 (RFC 1321) over UTF-8, hex out. Only used to check Moodle's
// signature: md5(siteurl + passport).

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const m = view.getUint32(off + g * 4, true);
      const sum = (a + f + K[i] + m) >>> 0;
      a = d; d = c; c = b;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let hex = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------

function randomPassport(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads `web+ready://token=<base64>` and checks it. Returns only yes/no facts. */
function checkLaunch(u: string, passport: string | null): ResultB {
  const m = /token=([A-Za-z0-9+/=_-]+)/.exec(u);
  if (!m) return { received: false, signatureMatches: false, privateToken: false };
  let decoded: string | null;
  try {
    decoded = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return { received: false, signatureMatches: false, privateToken: false };
  }
  let parts: string[] | null = decoded.split(":::");
  decoded = null;
  const signature = parts[0] ?? "";
  const hasToken = Boolean(parts[1]);
  const privateToken = Boolean(parts[2]);
  parts = null; // drop the token
  const http = SITE.replace(/^https:/, "http:");
  const signatureMatches = Boolean(passport) && (signature === md5(SITE + passport) || signature === md5(http + passport));
  return { received: hasToken, signatureMatches, privateToken };
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

function summaryA(a: AnswerA): string {
  return a.ok
    ? `Test A: ok, site info answered (${a.site?.functions ?? 0} functions), region ${a.serverRegion}, ${a.ms} ms`
    : `Test A: failed, errorcode ${a.errorcode ?? "none"}, region ${a.serverRegion}, ${a.ms} ms${a.message ? ` (${a.message})` : ""}`;
}

function summaryB(b: ResultB): string {
  return `Test B: key received ${yesNo(b.received)}, signature matches passport ${yesNo(b.signatureMatches)}, private token included ${yesNo(b.privateToken)}`;
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // private window: fine, Test B just cannot check the signature
  }
}

export function SignInTests() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [lineA, setLineA] = useState<string | null>(null);
  const [answerA, setAnswerA] = useState<AnswerA | null>(null);
  const [resultB, setResultB] = useState<ResultB | null>(null);
  const [errorB, setErrorB] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Coming back from the school's LMS with ?u=web+ready://token=...
  // Reading the address bar and sessionStorage once on load is the point of
  // this effect, so setting state in it is intended.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let u: string | null = new URLSearchParams(location.search).get("u");
    // Restore Test A's line (no token in it) from before the round trip.
    const savedA = readSession(SUMMARY_A_KEY);
    if (!u) {
      if (savedA) setLineA(savedA);
      return;
    }
    history.replaceState(null, "", location.pathname); // get the token out of the address bar first
    const passport = readSession(PASSPORT_KEY);
    writeSession(PASSPORT_KEY, null);
    const result = checkLaunch(u, passport);
    u = null; // drop the token
    setResultB(result);
    if (savedA) setLineA(savedA);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function tryA() {
    setBusy(true);
    setAnswerA(null);
    try {
      const res = await fetch("/api/dev/signin-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const a = (await res.json()) as AnswerA;
      setAnswerA(a);
      const line = summaryA(a);
      setLineA(line);
      writeSession(SUMMARY_A_KEY, line);
    } catch (e) {
      const line = `Test A: the request to our server failed (${e instanceof Error ? e.message : "unknown"})`;
      setLineA(line);
    } finally {
      setText(""); // the key is single-use; clear it
      setBusy(false);
    }
  }

  function startB() {
    setErrorB(null);
    try {
      navigator.registerProtocolHandler(SCHEME, `${location.origin}/dev/signin-test?u=%s`);
    } catch (e) {
      setErrorB(`Could not register the link type: ${e instanceof Error ? e.message : String(e)}. Copy this line into the results.`);
      return; // stay here so the error can be read
    }
    const passport = randomPassport();
    writeSession(PASSPORT_KEY, passport);
    // An external Moodle URL, not a Next.js page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`${SITE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${passport}&urlscheme=web%2Bready`);
  }

  const lines = [lineA ?? "Test A: not run", resultB ? summaryB(resultB) : "Test B: not run"];

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-6 space-y-8">
      <section>
        <h2 className="font-semibold">Test A: sign in from our server</h2>
        <textarea
          className="mt-2 h-24 w-full rounded border border-line bg-surface p-2 font-mono text-xs"
          placeholder="moodlemobile://https://mycourses.aalto.fi?qrlogin=...&userid=..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="mt-2 rounded bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
          onClick={tryA}
          disabled={busy || !text.trim()}
        >
          {busy ? "Trying..." : "Try"}
        </button>
        {answerA && (
          <p className="mt-2 text-sm">
            {answerA.ok ? `It worked: ${LMS} accepted the swap from our server.` : `It did not work: ${answerA.errorcode ?? "unknown"}.`}
            {answerA.errorcode === "ipmismatch" && ` ${LMS} wants the QR shown and read from the same network address.`}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-semibold">Test B: does {LMS} send the key back to us?</h2>
        <button type="button" className="mt-2 rounded bg-ink px-4 py-2 text-sm text-paper" onClick={startB}>
          Open {LMS} launch link
        </button>
        {errorB && <p className="mt-2 text-sm text-due">{errorB}</p>}
        {resultB && (
          <ul className="mt-2 text-sm">
            <li>Key received: {yesNo(resultB.received)}</li>
            <li>Signature matches passport: {yesNo(resultB.signatureMatches)}</li>
            <li>Private token included: {yesNo(resultB.privateToken)}</li>
          </ul>
        )}
        <div className="mt-3 text-sm text-ink-2">
          <p className="font-medium text-ink">What happened?</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>You came back to this page and it says &quot;Key received: yes&quot;: {LMS} honours our own link type. Good.</li>
            <li>The browser tried to open the Moodle app (a <code>moodlemobile://</code> link, or &quot;no app to open this&quot;): {LMS} forces its own link type, so ours is ignored.</li>
            <li>Nothing happened, or you stayed on a {LMS} page: the link was blocked. Write down what the page says.</li>
          </ul>
          <p className="mt-1">If {LMS} asks you to confirm or sign in first, do that and carry on.</p>
        </div>
      </section>

      <section className="rounded border border-line bg-surface p-3">
        <h2 className="font-semibold">Results</h2>
        <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{lines.join("\n")}</pre>
        <button type="button" className="mt-2 rounded border border-line px-3 py-1 text-sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </section>
    </div>
  );
}

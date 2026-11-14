// macOS Keychain helper for the M0 test sittings (ticket M0-15). A test convenience for
// her own Mac session, with her consent; not the app's design.
//
// One generic password per site: service "ready-moodle-test", account = normalised site.
// The key never goes on a command line (visible in `ps`): set() feeds the command to
// `security -i` on stdin. get() reads it from `security find-generic-password -w` stdout.
//
// Tests point READY_KEYCHAIN_CMD (or the `cmd` option) at a fake `security` so they never
// touch the real Keychain.

import { spawn } from "node:child_process";

export const SERVICE = "ready-moodle-test";

/** Same account name for login, fetch and probe: lower-case origin + path, no trailing slash. */
export function normaliseSite(site) {
  let s = String(site ?? "").trim();
  if (!s) throw new Error("No site given");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`.toLowerCase();
}

const command = (cmd) => cmd || process.env.READY_KEYCHAIN_CMD || "security";

function run(cmd, args, input) {
  return new Promise((done) => {
    const child = spawn(command(cmd), args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (err) => done({ code: -1, stdout: "", stderr: err.code || "spawn failed" }));
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// `security -i` splits its input like a shell: double quotes, backslash escapes.
const quote = (s) => `"${String(s).replace(/[\\"]/g, "\\$&")}"`;

/** The stored key for this site, or null. */
export async function get(site, { cmd } = {}) {
  const r = await run(cmd, ["find-generic-password", "-s", SERVICE, "-a", normaliseSite(site), "-w"]);
  if (r.code !== 0) return null;
  const key = r.stdout.replace(/\r?\n$/, "");
  return key || null;
}

/** Store (or replace) the key for this site. Throws a key-free Error on failure. */
export async function set(site, key, { cmd } = {}) {
  if (!key || /[\r\n]/.test(key)) throw new Error("Refusing to store an empty or multi-line key");
  const account = normaliseSite(site);
  const line = `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -l ${quote(`Ready M0 test key (${account})`)} -w ${quote(key)}\n`;
  const r = await run(cmd, ["-i"], line);
  const back = await get(account, { cmd });
  if (back !== key) {
    throw new Error(`Could not save the key in the Keychain (security exit ${r.code}). If macOS asked for access, allow it and try again.`);
  }
}

/** Remove the key for this site. Resolves true if one was removed. */
export async function remove(site, { cmd } = {}) {
  const r = await run(cmd, ["delete-generic-password", "-s", SERVICE, "-a", normaliseSite(site)]);
  return r.code === 0;
}

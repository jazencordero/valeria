// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { pushSubscriptions } from "@/server/db/schema/calendar";
import { users } from "@/server/db/schema/users";
import { createTestDb, type TestDb } from "@/server/db/test-db";

// The subscribe route reads the app database and the session; point both at this test.
const holder = vi.hoisted(() => ({ db: undefined as unknown, user: null as unknown }));
vi.mock("@/server/db/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db/client")>();
  const db = new Proxy({} as Db, {
    get(_t, prop) {
      const target = holder.db as Db;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...real, db };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/auth/session")>();
  return {
    ...real,
    currentUser: async () => {
      if (!holder.user) throw new real.NotSignedIn();
      return holder.user;
    },
  };
});

const { sendPush, vapidConfig, vapidPublicKey, isPushEndpoint, safePath } = await import("./send");
type PushSender = import("./send").PushSender;
const { POST, DELETE } = await import("@/app/api/push/subscribe/route");

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

// Placeholder strings, not real keys: the fake sender never uses them.
const ENV = { VAPID_PUBLIC_KEY: "test-public", VAPID_PRIVATE_KEY: "test-private", VAPID_SUBJECT: "https://ready.example" };
const KEYS = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
const endpoint = (n: string) => `https://fcm.googleapis.com/fcm/send/${n}`;
const MESSAGE = { title: "Due tonight", body: "Essay 2 at 21:00", url: "/assignments/a1" };

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
  holder.db = t.db;
  holder.user = null;
});
afterEach(() => t.close());

async function newUser(settings: Record<string, unknown> = {}) {
  const [user] = await t.db.insert(users).values({ settings }).returning();
  return user;
}

async function subscribe(userId: string, ep: string) {
  await t.db.insert(pushSubscriptions).values({ userId, endpoint: ep, keys: KEYS });
}

async function endpointsOf(userId: string) {
  const rows = await t.db
    .select({ endpoint: pushSubscriptions.endpoint })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  return rows.map((r) => r.endpoint).sort();
}

function goneAnswer(statusCode: number) {
  return Object.assign(new Error("Received unexpected response code"), { statusCode });
}

describe("sendPush", () => {
  it("is a no-op that says not_configured without keys", async () => {
    const user = await newUser();
    await subscribe(user.id, endpoint("one"));
    const send = vi.fn<PushSender>();
    expect(await sendPush(user.id, MESSAGE, { db: t.db, send, env: {} })).toEqual({ status: "not_configured" });
    expect(
      await sendPush(user.id, MESSAGE, { db: t.db, send, env: { VAPID_PUBLIC_KEY: "x", VAPID_SUBJECT: "https://a" } }),
    ).toEqual({ status: "not_configured" });
    expect(send).not.toHaveBeenCalled();
    expect(await endpointsOf(user.id)).toEqual([endpoint("one")]);
  });

  it("sends the title, body and path to each of her devices", async () => {
    const user = await newUser();
    await subscribe(user.id, endpoint("phone"));
    await subscribe(user.id, endpoint("laptop"));
    const send = vi.fn<PushSender>().mockResolvedValue({ statusCode: 201 });

    const result = await sendPush(user.id, MESSAGE, { db: t.db, send, env: ENV });

    expect(result).toEqual({ status: "sent", sent: 2, removed: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
    const [sub, payload, options] = send.mock.calls[0];
    expect(sub.keys).toEqual(KEYS);
    expect(JSON.parse(payload)).toEqual(MESSAGE);
    expect(options.vapidDetails).toEqual({
      publicKey: ENV.VAPID_PUBLIC_KEY,
      privateKey: ENV.VAPID_PRIVATE_KEY,
      subject: ENV.VAPID_SUBJECT,
    });
  });

  it("deletes a subscription the push service answers 410 (or 404) for", async () => {
    const user = await newUser();
    await subscribe(user.id, endpoint("gone"));
    await subscribe(user.id, endpoint("missing"));
    await subscribe(user.id, endpoint("alive"));
    const send = vi.fn<PushSender>(async (sub) => {
      if (sub.endpoint === endpoint("gone")) throw goneAnswer(410);
      if (sub.endpoint === endpoint("missing")) throw goneAnswer(404);
      return { statusCode: 201 };
    });

    const result = await sendPush(user.id, MESSAGE, { db: t.db, send, env: ENV });

    expect(result).toEqual({ status: "sent", sent: 1, removed: 2, failed: 0 });
    expect(await endpointsOf(user.id)).toEqual([endpoint("alive")]);
  });

  it("keeps a subscription on other failures and counts them", async () => {
    const user = await newUser();
    await subscribe(user.id, endpoint("busy"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn<PushSender>().mockRejectedValue(goneAnswer(500));

    const result = await sendPush(user.id, MESSAGE, { db: t.db, send, env: ENV });

    expect(result).toEqual({ status: "sent", sent: 0, removed: 0, failed: 1 });
    expect(await endpointsOf(user.id)).toEqual([endpoint("busy")]);
    warn.mockRestore();
  });

  it("leaves other users' subscriptions untouched", async () => {
    const her = await newUser();
    const other = await newUser();
    await subscribe(her.id, endpoint("hers"));
    await subscribe(other.id, endpoint("theirs"));
    const send = vi.fn<PushSender>().mockRejectedValue(goneAnswer(410));

    const result = await sendPush(her.id, MESSAGE, { db: t.db, send, env: ENV });

    expect(result).toEqual({ status: "sent", sent: 0, removed: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].endpoint).toBe(endpoint("hers"));
    expect(await endpointsOf(her.id)).toEqual([]);
    expect(await endpointsOf(other.id)).toEqual([endpoint("theirs")]);
  });

  it("sends only same-site paths; anything else opens Home", async () => {
    const user = await newUser();
    await subscribe(user.id, endpoint("p"));
    const send = vi.fn<PushSender>().mockResolvedValue({});
    await sendPush(user.id, { ...MESSAGE, url: "https://evil.example/x" }, { db: t.db, send, env: ENV });
    expect(JSON.parse(send.mock.calls[0][1]).url).toBe("/");
    expect(safePath("//evil.example")).toBe("/");
    expect(safePath("/exams/1?tab=plan")).toBe("/exams/1?tab=plan");
  });
});

describe("config and endpoints", () => {
  it("falls back to the production address for the subject", () => {
    expect(
      vapidConfig({ VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "s", VERCEL_PROJECT_PRODUCTION_URL: "ready.example" }),
    ).toEqual({ publicKey: "p", privateKey: "s", subject: "https://ready.example" });
    expect(vapidPublicKey({})).toBeNull();
    expect(vapidPublicKey(ENV)).toBe("test-public");
  });

  it("accepts only https push service addresses", () => {
    expect(isPushEndpoint(endpoint("x"))).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QW1")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/x")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("not a url")).toBe(false);
  });
});

describe("/api/push/subscribe", () => {
  const request = (method: string, body: unknown) =>
    new Request("https://ready.example/api/push/subscribe", {
      method,
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const subscription = (n: string) => ({ endpoint: endpoint(n), expirationTime: null, keys: KEYS });

  it("stores this phone once (upsert by endpoint) and forgets it on DELETE", async () => {
    const user = await newUser();
    holder.user = user;

    expect((await POST(request("POST", subscription("phone")))).status).toBe(201);
    expect((await POST(request("POST", subscription("phone")))).status).toBe(201);
    expect(await endpointsOf(user.id)).toEqual([endpoint("phone")]);

    const res = await DELETE(request("DELETE", { endpoint: endpoint("phone") }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: 1 });
    expect(await endpointsOf(user.id)).toEqual([]);
  });

  it("moves an endpoint to the user now signed in on that phone", async () => {
    const old = await newUser();
    const now = await newUser();
    await subscribe(old.id, endpoint("phone"));
    holder.user = now;
    expect((await POST(request("POST", subscription("phone")))).status).toBe(201);
    expect(await endpointsOf(old.id)).toEqual([]);
    expect(await endpointsOf(now.id)).toEqual([endpoint("phone")]);
  });

  it("does not delete another user's subscription", async () => {
    const other = await newUser();
    await subscribe(other.id, endpoint("theirs"));
    holder.user = await newUser();
    const res = await DELETE(request("DELETE", { endpoint: endpoint("theirs") }));
    expect(await res.json()).toEqual({ ok: true, removed: 0 });
    expect(await endpointsOf(other.id)).toEqual([endpoint("theirs")]);
  });

  it("rejects bad bodies, strangers and demo users", async () => {
    holder.user = null;
    expect((await POST(request("POST", subscription("x")))).status).toBe(401);

    const user = await newUser();
    holder.user = user;
    expect((await POST(request("POST", "not json"))).status).toBe(400);
    expect((await POST(request("POST", { ...subscription("x"), endpoint: "https://evil.example/x" }))).status).toBe(400);
    expect((await POST(request("POST", { endpoint: endpoint("x"), keys: { p256dh: "short", auth: "" } }))).status).toBe(
      400,
    );
    expect(await endpointsOf(user.id)).toEqual([]);

    holder.user = await newUser({ demo: true });
    const res = await POST(request("POST", subscription("demo")));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "demo" });
  });
});

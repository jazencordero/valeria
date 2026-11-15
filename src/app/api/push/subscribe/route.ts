import { and, asc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { currentUser, NotSignedIn, type User } from "@/server/auth/session";
import { db } from "@/server/db/client";
import { pushSubscriptions } from "@/server/db/schema/calendar";
import { isDemo } from "@/server/demo/seed";
import { isPushEndpoint } from "@/server/push/send";
import { allow } from "@/server/throttle";

// M7-06: "Notifications on this phone" stores or forgets this device's push
// subscription for the signed-in user.
//
// POST   { endpoint, keys: { p256dh, auth }, expirationTime? }  -> 201 { ok: true }
// DELETE { endpoint }                                            -> 200 { ok: true, removed }
//
// The body is what `PushSubscription.toJSON()` gives in the browser. Rows are
// upserted by endpoint (unique), so turning it on twice on one phone is one
// row; a phone whose endpoint was stored for another user (she signed out
// everywhere and got a new user on this device) moves to the current user,
// because only that browser knows the endpoint.
//
// Demo users may not subscribe: a demo is shared, short-lived sample data, and
// a phone subscribed to it would get notifications about someone else's sample
// week after the demo is reset. They get 403 { error: "demo" }.

const NO_STORE = { "Cache-Control": "no-store" };
/** A subscription is under 1 KB; anything much larger is not one. */
const MAX_BODY_BYTES = 4096;
/** Devices kept per user; the oldest beyond this are dropped. */
const MAX_DEVICES = 10;

// base64url, as browsers send p256dh (65 bytes -> 87 chars) and auth (16 -> 22).
const b64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/);

const endpointSchema = z
  .string()
  .max(1024)
  .refine(isPushEndpoint, { message: "not a push service address" });

const subscribeSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: b64url(80, 100),
    auth: b64url(16, 32),
  }),
});

const unsubscribeSchema = z.object({ endpoint: endpointSchema });

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

async function signedIn(): Promise<User | Response> {
  try {
    return await currentUser();
  } catch (error) {
    if (error instanceof NotSignedIn) return json({ error: "not_signed_in" }, 401);
    throw error;
  }
}

/** The parsed JSON body, or null when it is missing, too big or not JSON. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text().catch(() => "");
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const user = await signedIn();
  if (user instanceof Response) return user;
  if (isDemo(user)) return json({ error: "demo" }, 403);

  const parsed = subscribeSchema.safeParse(await readBody(request));
  if (!parsed.success) return json({ error: "invalid_subscription" }, 400);

  if (!(await allow("push-subscribe", { max: 20, perSeconds: 60 * 60 }, { userId: user.id }))) {
    return json({ error: "too_many_tries" }, 429);
  }

  const { endpoint, keys } = parsed.data;
  await db
    .insert(pushSubscriptions)
    .values({ userId: user.id, endpoint, keys })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: user.id, keys },
    });

  // Keep the newest MAX_DEVICES (this one included).
  const kept = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, user.id))
    .orderBy(asc(pushSubscriptions.createdAt));
  if (kept.length > MAX_DEVICES) {
    const newest = kept.slice(-MAX_DEVICES).map((r) => r.id);
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, user.id), notInArray(pushSubscriptions.id, newest)));
  }

  return json({ ok: true }, 201);
}

export async function DELETE(request: Request) {
  const user = await signedIn();
  if (user instanceof Response) return user;

  const parsed = unsubscribeSchema.safeParse(await readBody(request));
  if (!parsed.success) return json({ error: "invalid_subscription" }, 400);

  const gone = await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, parsed.data.endpoint)))
    .returning({ id: pushSubscriptions.id });

  return json({ ok: true, removed: gone.length });
}

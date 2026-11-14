// A HerTap is the proof that she pressed "Hand in" on the review screen. Every
// function in ./write takes one, so the compiler refuses any Moodle write that
// is not her click: sync, jobs and cron can never hand in for her.
//
// The only way to make one is `herTapFromConfirmCode`, which uses up her
// one-time confirm code (a `confirm_codes` row with purpose "handin"). Only
// src/server/handin/confirm.ts calls it (tests/arch/write-boundary.test.ts
// keeps it that way).
//
// Forging one does not work either way:
// - at compile time the brand key is a `unique symbol` this file does not
//   export, so no other file can write a value of type HerTap without a cast;
// - at run time ./write checks every tap against a private registry, so a cast
//   object (`{} as HerTap`) is refused.
//
// One tap covers one hand-in of one assignment by one user: uploads, then at
// most one save, then at most one submit. After the submit it is spent.

declare const herTapBrand: unique symbol;

export type HerTap = {
  readonly userId: string;
  /** The Moodle assignment id (`assignmentid`) she confirmed. */
  readonly assignId: number;
  readonly [herTapBrand]: true;
};

/** `confirm_codes.purpose` for a hand-in. */
export const HANDIN_PURPOSE = "handin" as const;

/** Why a confirm code did not make a tap. */
export type HerTapRefusal =
  /** No code with this id belongs to her, or it is not a hand-in code. */
  | "not_found"
  /** She, or a double click, already used it. */
  | "used"
  | "expired"
  /** The code is hers and fresh, but for another assignment or another file. */
  | "changed";

export type ConfirmCodeCheck = {
  /** The code she was shown: `confirm_codes.id`. */
  code: string;
  userId: string;
  purpose: typeof HANDIN_PURPOSE;
  payloadHash: string;
  now: Date;
};

/**
 * Use up one confirm code. Answers "ok" and marks the code used only when it
 * is hers, has this purpose and payload hash, is unused and not expired; the
 * check and the marking must be one atomic step, so two taps at once cannot
 * both get "ok". Otherwise answers why, and leaves the code as it was.
 */
export type ConsumeConfirmCode = (check: ConfirmCodeCheck) => Promise<"ok" | HerTapRefusal>;

export type HerTapRequest = {
  userId: string;
  assignId: number;
  /** The confirm code from the review step. */
  code: string;
  /** The hash confirm.ts computes from what she is handing in now; must equal the stored one. */
  payloadHash: string;
};

export type HerTapResult = { ok: true; tap: HerTap } | { ok: false; reason: HerTapRefusal };

type Stage = "open" | "saved" | "spent";
const issued = new WeakMap<object, { stage: Stage }>();

/**
 * Use up her confirm code and, if it was good, make the tap for this hand-in.
 * `consume` defaults to the `confirm_codes` table; tests pass their own.
 */
export async function herTapFromConfirmCode(
  req: HerTapRequest,
  consume: ConsumeConfirmCode = dbConsumeConfirmCode(),
  now: Date = new Date(),
): Promise<HerTapResult> {
  if (!req.userId || !req.code || !req.payloadHash || !Number.isSafeInteger(req.assignId) || req.assignId <= 0) {
    return { ok: false, reason: "not_found" };
  }
  const answer = await consume({
    code: req.code,
    userId: req.userId,
    purpose: HANDIN_PURPOSE,
    payloadHash: req.payloadHash,
    now,
  });
  if (answer !== "ok") return { ok: false, reason: answer };
  const tap = Object.freeze({ userId: req.userId, assignId: req.assignId }) as HerTap;
  issued.set(tap, { stage: "open" });
  return { ok: true, tap };
}

/** A tap was missing, forged, spent, or used for another user, assignment or step. */
export class HerTapInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerTapInvalid";
  }
}

export type TapStep = "upload" | "save" | "submit";

/**
 * For ./write only: check the tap may do this step for this user and
 * assignment, and move it on (save closes uploads; submit spends it). Throws
 * HerTapInvalid before any request is made.
 */
export function stepHerTap(tap: HerTap, step: TapStep, userId: string | undefined, assignId?: number): void {
  const state = typeof tap === "object" && tap !== null ? issued.get(tap) : undefined;
  if (!state) throw new HerTapInvalid("Not a tap made from her confirm code");
  if (!userId || tap.userId !== userId) throw new HerTapInvalid("The tap belongs to another user");
  if (assignId !== undefined && tap.assignId !== assignId) throw new HerTapInvalid("The tap is for another assignment");
  if (state.stage === "spent") throw new HerTapInvalid("The tap is already spent");
  if (state.stage === "saved" && step !== "submit") throw new HerTapInvalid(`The submission is already saved; no ${step} after that`);
  if (step === "save") state.stage = "saved";
  if (step === "submit") state.stage = "spent";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ConsumeConfirmCode` on the `confirm_codes` table: one UPDATE ... RETURNING
 * marks the code used only if every condition holds; when it does not, one
 * read says why. The database client is imported only when first used. Pass
 * `db` to use another handle (tests).
 */
export function dbConsumeConfirmCode(db?: import("../db/client").Db): ConsumeConfirmCode {
  return async ({ code, userId, purpose, payloadHash, now }) => {
    if (!UUID.test(code) || !UUID.test(userId)) return "not_found";
    const [{ and, eq, gt, isNull }, { confirmCodes }] = await Promise.all([
      import("drizzle-orm"),
      import("../db/schema/users"),
    ]);
    const d = db ?? (await import("../db/client")).db;
    const mine = and(eq(confirmCodes.id, code), eq(confirmCodes.userId, userId), eq(confirmCodes.purpose, purpose));
    const used = await d
      .update(confirmCodes)
      .set({ usedAt: now })
      .where(and(mine, eq(confirmCodes.payloadHash, payloadHash), isNull(confirmCodes.usedAt), gt(confirmCodes.expiresAt, now)))
      .returning({ id: confirmCodes.id });
    if (used.length === 1) return "ok";
    const [row] = await d
      .select({ usedAt: confirmCodes.usedAt, expiresAt: confirmCodes.expiresAt, payloadHash: confirmCodes.payloadHash })
      .from(confirmCodes)
      .where(mine)
      .limit(1);
    if (!row) return "not_found";
    if (row.usedAt) return "used";
    if (row.expiresAt <= now) return "expired";
    return "changed";
  };
}

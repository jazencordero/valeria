"use client";

/**
 * "Notifications on this phone" (M7-06).
 *
 *   <PushToggle publicKey={vapidPublicKey()} demo={isDemo(user)} />
 *
 * `publicKey` is the VAPID public key, read on the server and passed down;
 * null means push is not set up on this deployment. The private key never
 * reaches the browser.
 *
 * Nothing is asked on load: the permission prompt and the service worker
 * registration happen only after she taps the switch. On load it only looks
 * for a subscription this phone already has.
 *
 * On an iPhone, web notifications work only in the home-screen app, so in
 * Safari (not installed) it shows the one-line instruction instead.
 */
import { useEffect, useId, useState } from "react";

export type PushToggleProps = {
  publicKey: string | null;
  demo?: boolean;
};

type View =
  | "checking"
  | "not_configured"
  | "demo"
  | "install"
  | "unsupported"
  | "denied"
  | "off"
  | "on";

export const PUSH_COPY = {
  label: "Notifications on this phone",
  install: "Add Ready to your Home Screen first to get notifications.",
  unsupported: "This browser can't show notifications from Ready.",
  notConfigured: "Notifications aren't set up yet.",
  demo: "Notifications are off in the demo.",
  denied: "Notifications are blocked. Allow them for Ready in your phone's settings.",
  failed: "Couldn't change notifications. Try again.",
} as const;

const SW_URL = "/sw.js";
const SUBSCRIBE_URL = "/api/push/subscribe";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

function isIOS(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** This phone's current subscription for `publicKey`, without registering anything. */
async function existingSubscription(publicKey: string): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = (await registration?.pushManager.getSubscription()) ?? null;
  if (!subscription) return null;
  return sameKey(subscription.options.applicationServerKey, urlBase64ToUint8Array(publicKey)) ? subscription : null;
}

async function firstView(publicKey: string | null, demo: boolean): Promise<View> {
  if (!publicKey) return "not_configured";
  if (demo) return "demo";
  const supported = pushSupported();
  if (!isStandalone() && (isIOS() || !supported)) return "install";
  if (!supported) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    return (await existingSubscription(publicKey)) ? "on" : "off";
  } catch {
    return "off";
  }
}

export function PushToggle({ publicKey, demo = false }: PushToggleProps) {
  const labelId = useId();
  const [view, setView] = useState<View>("checking");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void firstView(publicKey, demo).then((v) => {
      if (live) setView(v);
    });
    return () => {
      live = false;
    };
  }, [publicKey, demo]);

  async function turnOn(key: string) {
    // Asked here, straight from her tap, before anything else is awaited:
    // Safari only shows the prompt inside the tap's own handler.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setView(permission === "denied" ? "denied" : "off");
      return;
    }
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const serverKey = urlBase64ToUint8Array(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, serverKey)) {
      // Made with an older key: a new one is needed.
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKey,
    });
    const response = await fetch(SUBSCRIBE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) {
      await subscription.unsubscribe().catch(() => undefined);
      if (response.status === 403) {
        setView("demo");
        return;
      }
      throw new Error(`subscribe answered ${response.status}`);
    }
    setView("on");
  }

  async function turnOff(key: string) {
    const subscription = await existingSubscription(key);
    if (subscription) {
      const { endpoint } = subscription;
      await subscription.unsubscribe();
      await fetch(SUBSCRIBE_URL, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    }
    setView("off");
  }

  async function toggle() {
    if (busy || !publicKey || (view !== "on" && view !== "off")) return;
    setBusy(true);
    setFailed(false);
    try {
      await (view === "on" ? turnOff(publicKey) : turnOn(publicKey));
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const note =
    view === "not_configured"
      ? PUSH_COPY.notConfigured
      : view === "demo"
        ? PUSH_COPY.demo
        : view === "install"
          ? PUSH_COPY.install
          : view === "unsupported"
            ? PUSH_COPY.unsupported
            : view === "denied"
              ? PUSH_COPY.denied
              : failed
                ? PUSH_COPY.failed
                : null;

  const usable = view === "on" || view === "off";

  return (
    <div className="flex flex-col gap-1" data-view={view}>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <span id={labelId} className="text-[15px] text-ink">
          {PUSH_COPY.label}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={view === "on"}
          aria-labelledby={labelId}
          aria-disabled={!usable || busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => void toggle()}
          className="group grid h-11 w-[52px] flex-none place-items-center rounded-full border-0 bg-transparent p-0 aria-disabled:opacity-50"
        >
          <span className="relative h-[26px] w-11 rounded-full bg-line transition-colors duration-quick ease-out group-aria-checked:bg-ink">
            <span className="absolute top-[3px] left-[3px] size-5 rounded-full bg-surface shadow-[var(--shadow-card)] transition-transform duration-base ease-out group-aria-checked:translate-x-[18px]" />
          </span>
        </button>
      </div>
      {note ? (
        <p className="text-[13px] text-ink-2" role={failed ? "alert" : undefined}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

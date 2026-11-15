"use client";

/**
 * Scan or upload the QR code (M5-06). Her Moodle profile shows a QR code that
 * signs the Moodle app in; we read its text and hand it to `connectWithQr`
 * (M5-05) through a server action. Wording of the steps:
 * context/moodle/findings.md says the code is on her profile; the exact menu
 * label ("View QR code") is unverified, so the steps do not quote it.
 *
 * Two ways in:
 * - Phone: "I have {lms} open on my laptop". Only after her tap do we ask for
 *   the back camera. Frames are read with the browser's `BarcodeDetector`
 *   when it has one, else with `jsqr` on a canvas, about seven a second. The
 *   camera is stopped the moment a code is read, and on unmount.
 * - Any device: "Upload a screenshot of the code", decoded with `jsqr`.
 * Camera refused or missing: the camera way quietly goes away and the upload
 * way stays. A picture with no QR in it: "No code found in that picture."
 *
 * Plain props, so a preview page can show every state:
 * - `lmsName`: from `lmsNameOf(user)` (never a literal here).
 * - `action`: gets the decoded text, answers `QrConnectResult`. The real one
 *   is `connectQrAction` in src/app/(first-run)/connect/qr-actions.ts.
 * - `onConnected`: called once on success; navigation is the caller's job.
 * - `camera`: show the camera way. Defaults to "a phone with a camera API"
 *   (coarse pointer plus `getUserMedia`), decided after mount.
 * - `readImage`: turns an uploaded file into pixels. Defaults to a canvas;
 *   tests pass a PNG reader because jsdom has no real canvas.
 *
 * Cut: no torch or zoom controls.
 */
import jsQR from "jsqr";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";

export type QrConnectResult = { ok: true } | { ok: false; message: string };

export type Pixels = { data: Uint8ClampedArray; width: number; height: number };

export type QrScanProps = {
  lmsName: string;
  action: (text: string) => Promise<QrConnectResult>;
  onConnected: () => void;
  camera?: boolean;
  readImage?: (file: File) => Promise<Pixels>;
};

export const NO_CODE = "No code found in that picture.";
const FAILED = "Something went wrong on our side. Try again in a minute.";
const SCAN_EVERY_MS = 150;

/** The text of the QR code in these RGBA pixels, or null when there is none. */
export function decodeQrPixels({ data, width, height }: Pixels): string | null {
  if (!width || !height || data.length < width * height * 4) return null;
  const found = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  return found?.data ? found.data : null;
}

/** Draws an image file on a canvas (at most 1600 px a side) and returns its pixels. */
export async function readImageWithCanvas(file: File): Promise<Pixels> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

type Detector = { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> };
type DetectorClass = new (opts: { formats: string[] }) => Detector;

function barcodeDetector(): Detector | null {
  const Ctor = (globalThis as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

function phoneWithCamera(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

const noSubscribe = () => () => {};

type Mode = "choose" | "camera" | "checking";

export function QrScan({ lmsName, action, onConnected, camera, readImage = readImageWithCanvas }: QrScanProps) {
  // Read after hydration (server snapshot false), so server and first client render agree.
  const detected = useSyncExternalStore(noSubscribe, phoneWithCamera, () => false);
  const [refused, setRefused] = useState(false);
  const cameraOk = (camera ?? detected) && !refused;
  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const ids = { steps: useId(), error: useId(), file: useId() };

  const stopCamera = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const submit = useCallback(
    async (text: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setMode("checking");
      setError(null);
      try {
        const result = await action(text);
        if (result.ok) {
          onConnected();
          return;
        }
        setError(result.message);
      } catch {
        setError(FAILED);
      } finally {
        busyRef.current = false;
      }
      setMode("choose");
    },
    [action, onConnected],
  );

  const startCamera = useCallback(async () => {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
      // Refused or no camera: quietly leave only the upload way.
      setRefused(true);
      setMode("choose");
      return;
    }
    streamRef.current = stream;
    setMode("camera");
    const video = videoRef.current;
    if (video) {
      video.srcObject = stream;
      video.play?.()?.catch(() => {});
    }

    const detector = barcodeDetector();
    let canvas: HTMLCanvasElement | null = null;
    const tick = async () => {
      timerRef.current = null;
      if (!streamRef.current) return;
      const v = videoRef.current;
      let text: string | null = null;
      try {
        if (detector && v) {
          const codes = await detector.detect(v);
          text = codes.find((c) => c.rawValue)?.rawValue ?? null;
        } else if (v && v.readyState >= 2 && v.videoWidth) {
          canvas ??= document.createElement("canvas");
          canvas.width = v.videoWidth;
          canvas.height = v.videoHeight;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            text = decodeQrPixels(ctx.getImageData(0, 0, canvas.width, canvas.height));
          }
        }
      } catch {
        // A frame that cannot be read yet; try the next one.
      }
      if (!streamRef.current) return;
      if (text) {
        stopCamera();
        void submit(text);
        return;
      }
      timerRef.current = setTimeout(tick, SCAN_EVERY_MS);
    };
    timerRef.current = setTimeout(tick, 0);
  }, [stopCamera, submit]);

  const cancelCamera = useCallback(() => {
    stopCamera();
    setMode("choose");
  }, [stopCamera]);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      let text: string | null = null;
      try {
        text = decodeQrPixels(await readImage(file));
      } catch {
        text = null;
      }
      if (fileRef.current) fileRef.current.value = "";
      if (!text) {
        setError(NO_CODE);
        return;
      }
      await submit(text);
    },
    [readImage, submit],
  );

  const checking = mode === "checking";
  const steps = [
    <>Open {lmsName} on your laptop.</>,
    <>Go to your profile and show the QR code there.</>,
    cameraOk ? <>Scan it with this phone, or upload a screenshot.</> : <>Take a screenshot of it and upload it here.</>,
  ];

  return (
    <div className="mx-auto flex w-full max-w-[440px] flex-col">
      <h2 className="font-display text-[22px] font-semibold leading-[1.2] tracking-[-0.01em] [font-variation-settings:'SOFT'_100]">
        Use the QR code
      </h2>

      <ol id={ids.steps} className="mt-4 grid list-none gap-3.5">
        {steps.map((step, i) => (
          <li key={i} className="grid grid-cols-[32px_1fr] items-baseline gap-x-3 text-[15px] text-ink">
            <span aria-hidden="true" className="mono grid size-7 place-items-center self-center rounded-full bg-paper text-ink-2">
              {i + 1}
            </span>
            <span>
              <span className="sr-only">Step {i + 1}: </span>
              {step}
            </span>
          </li>
        ))}
      </ol>

      <div hidden={mode !== "camera"} className="mt-6 grid gap-3">
        <video
          ref={videoRef}
          muted
          playsInline
          aria-label="Camera"
          className="aspect-square w-full rounded-2xl bg-ink object-cover"
        />
        <p className="text-center text-[14px] text-ink-2">Point it at the code on your laptop.</p>
        <Button variant="secondary" block onClick={cancelCamera}>
          Stop the camera
        </Button>
      </div>

      <div hidden={mode === "camera"} className="mt-6 grid gap-3">
        {cameraOk && (
          <Button size="lg" block disabled={checking} onClick={() => void startCamera()}>
            I have {lmsName} open on my laptop
          </Button>
        )}
        <Button
          variant={cameraOk ? "secondary" : "primary"}
          size="lg"
          block
          loading={checking}
          loadingLabel="Connecting"
          onClick={() => fileRef.current?.click()}
        >
          Upload a screenshot of the code
        </Button>
        <input
          ref={fileRef}
          id={ids.file}
          type="file"
          accept="image/*"
          aria-label="Screenshot of the code"
          className="sr-only"
          tabIndex={-1}
          disabled={checking}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      <p id={ids.error} role="alert" className="mt-3 text-[14px] text-ink empty:hidden">
        {error}
      </p>
    </div>
  );
}

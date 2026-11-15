import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCHOOLS } from "@/lib/schools";
import { decodeQrPixels, NO_CODE, type Pixels, QrScan } from "./qr-scan";

const LMS = SCHOOLS.aalto.lms;
/** What tests/fixtures/files/sample-qr.png encodes: a fake QR for the Aalto site. */
const SAMPLE_TEXT = "moodlemobile://https://mycourses.aalto.fi?qrlogin=demoqrkey123&userid=4242";
const SAMPLE_PNG = readFileSync(join(process.cwd(), "tests/fixtures/files/sample-qr.png"));

/** A tiny PNG reader (8-bit grey, RGB or RGBA, not interlaced) so tests need no canvas. */
function readPng(buf: Uint8Array): Pixels {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat: Uint8Array[] = [];
  while (p < buf.length) {
    const len = view.getUint32(p);
    const name = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const body = buf.subarray(p + 8, p + 8 + len);
    if (name === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      if (body[8] !== 8 || body[12] !== 0) throw new Error("unsupported PNG");
      type = body[9];
    }
    if (name === "IDAT") idat.push(body);
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 6: 4 }[type as 0 | 2 | 6];
  if (!channels) throw new Error("unsupported PNG colour type");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? rows[y * stride + x - channels] : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
      const paeth = () => {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      const add = [0, a, b, (a + b) >> 1, paeth()][filter];
      rows[y * stride + x] = (v + add) & 0xff;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const [r, g, bl] = channels === 1 ? [rows[s], rows[s], rows[s]] : [rows[s], rows[s + 1], rows[s + 2]];
    data.set([r, g, bl, channels === 4 ? rows[s + 3] : 255], i * 4);
  }
  return { data, width, height };
}

/** Random grey pixels: no QR code in there. */
function noise(width = 200, height = 200): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const v = seed & 0xff;
    data.set([v, v, v, 255], i * 4);
  }
  return { data, width, height };
}

/** Test reader: a PNG goes through `readPng`; a file called noise.png is random noise. */
async function readImage(file: File): Promise<Pixels> {
  if (file.name === "noise.png") return noise();
  return readPng(new Uint8Array(await file.arrayBuffer()));
}

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

function stubCamera(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>) {
  const fn = vi.fn(getUserMedia);
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: fn }, configurable: true });
  return fn;
}

function fakeStream() {
  const track = { stop: vi.fn(), kind: "video" };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
}

beforeEach(() => {
  stubMatchMedia();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("decodeQrPixels", () => {
  it("reads the sample QR image", () => {
    expect(decodeQrPixels(readPng(SAMPLE_PNG))).toBe(SAMPLE_TEXT);
  });

  it("finds nothing in noise", () => {
    expect(decodeQrPixels(noise())).toBeNull();
  });
});

describe("QrScan upload", () => {
  it("shows three steps naming the school's LMS", () => {
    render(<QrScan lmsName={LMS} action={vi.fn()} onConnected={vi.fn()} camera={false} />);
    const steps = screen.getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0].textContent).toContain(`Open ${LMS} on your laptop.`);
    expect(screen.queryByRole("button", { name: `I have ${LMS} open on my laptop` })).toBeNull();
    expect(screen.getByRole("button", { name: "Upload a screenshot of the code" })).toBeTruthy();
  });

  it("decodes the sample screenshot, sends its text and reports success", async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    const onConnected = vi.fn();
    render(<QrScan lmsName={LMS} action={action} onConnected={onConnected} camera={false} readImage={readImage} />);
    await userEvent.upload(
      screen.getByLabelText("Screenshot of the code"),
      new File([SAMPLE_PNG], "sample-qr.png", { type: "image/png" }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledWith(SAMPLE_TEXT);
  });

  it("says no code was found in a picture without one, and calls nothing", async () => {
    const action = vi.fn();
    render(<QrScan lmsName={LMS} action={action} onConnected={vi.fn()} camera={false} readImage={readImage} />);
    await userEvent.upload(screen.getByLabelText("Screenshot of the code"), new File(["x"], "noise.png", { type: "image/png" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No code found in that picture.");
    expect(NO_CODE).toBe("No code found in that picture.");
    expect(action).not.toHaveBeenCalled();
  });

  it("shows the action's sentence when connecting fails", async () => {
    const message = `That code ran out. Show it again in ${LMS}.`;
    const onConnected = vi.fn();
    render(
      <QrScan
        lmsName={LMS}
        action={async () => ({ ok: false, message })}
        onConnected={onConnected}
        camera={false}
        readImage={readImage}
      />,
    );
    await userEvent.upload(
      screen.getByLabelText("Screenshot of the code"),
      new File([SAMPLE_PNG], "sample-qr.png", { type: "image/png" }),
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("QrScan camera", () => {
  it("asks for the camera only after her tap; refused, it quietly leaves the upload way", async () => {
    const getUserMedia = stubCamera(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    render(<QrScan lmsName={LMS} action={vi.fn()} onConnected={vi.fn()} camera />);
    expect(getUserMedia).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: `I have ${LMS} open on my laptop` }));
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: "environment" }, audio: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: `I have ${LMS} open on my laptop` })).toBeNull());
    expect(screen.getByRole("button", { name: "Upload a screenshot of the code" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("");
  });

  it("stops every track the moment a code is read, then sends it", async () => {
    const { stream, track } = fakeStream();
    stubCamera(async () => stream);
    const detect = vi.fn(async () => [{ rawValue: SAMPLE_TEXT }]);
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect = detect;
      },
    );
    const action = vi.fn(async () => {
      // The camera is already off when the server is asked.
      expect(track.stop).toHaveBeenCalled();
      return { ok: true as const };
    });
    const onConnected = vi.fn();
    render(<QrScan lmsName={LMS} action={action} onConnected={onConnected} camera />);

    await userEvent.click(screen.getByRole("button", { name: `I have ${LMS} open on my laptop` }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(SAMPLE_TEXT);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("stops the camera when the screen goes away mid-scan", async () => {
    const { stream, track } = fakeStream();
    stubCamera(async () => stream);
    vi.stubGlobal(
      "BarcodeDetector",
      class {
        detect = async () => [];
      },
    );
    const { unmount } = render(<QrScan lmsName={LMS} action={vi.fn()} onConnected={vi.fn()} camera />);
    await userEvent.click(screen.getByRole("button", { name: `I have ${LMS} open on my laptop` }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop the camera" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Upload a screenshot of the code" })).toBeNull();
    expect(track.stop).not.toHaveBeenCalled();
    act(() => unmount());
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});

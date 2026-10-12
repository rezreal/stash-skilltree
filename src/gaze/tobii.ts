// The real tracker: Tobii 4C / ET5 / IS5 over WebUSB through the vendored
// tobiifree SDK (vendor/tobiifree). The SDK is loaded lazily on the first
// connect and can be injected (tests use a fake; no real USB).
//
// Samples: the SDK's gaze_point_2d_norm is in [0,1]² of the display the
// tracker is mounted on. We scale it to device px of that display with
// screenSize() (default window.screen * devicePixelRatio, which assumes the
// browser window is on the tracked display) and report the display at
// origin 0,0, so screenToViewport() treats it as the primary monitor. A
// tracker on a secondary monitor needs the page calibration to absorb the
// offset (or a screenSize/screen origin supplied by the caller).

import type { Source as SdkSource, GazeSample as SdkGazeSample, DisplayArea } from "../../vendor/tobiifree/sdk/src/index.ts";
import { createListeners, createRateCounter, defaultNow } from "./rate.ts";
import type { DeviceCalibration, GazeSample, GazeSource, GazeStatus } from "./types.ts";

/** What we use of the SDK module (vendor/tobiifree/sdk/src/index.ts). */
export interface TobiiSdk {
  Tobii: { fromUsb(opts?: { device?: USBDevice }): Promise<SdkSource> };
}

/** What we use of navigator.usb (a real USB object fits). */
export type UsbLike = Pick<USB, "getDevices" | "requestDevice" | "addEventListener" | "removeEventListener">;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TobiiSourceOptions {
  /** default navigator.usb */
  usb?: UsbLike;
  now?: () => number;
  /** device px of the tracked display, default window.screen * devicePixelRatio */
  screenSize?: () => { width: number; height: number };
  /** the SDK module or a loader for it, default a lazy import of the vendored SDK */
  sdk?: TobiiSdk | (() => Promise<TobiiSdk>);
  /** where the device calibration blob is kept; null = don't store or apply. Default localStorage */
  storage?: StorageLike | null;
}

// Same list as vendor/tobiifree/sdk/src/webusb.ts TOBII_USB_FILTERS (ET5 runtime, 4C, IS5).
export const TOBII_USB_FILTERS: USBDeviceFilter[] = [0x0313, 0x0127, 0x031e].map((productId) => ({
  vendorId: 0x2104,
  productId,
}));

export const TOBII_CALIBRATION_KEY = "skilltree.tobiiCalibration";

function isTobii(d: USBDevice): boolean {
  return TOBII_USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);
}

function navigatorUsb(): UsbLike | undefined {
  const nav = globalThis.navigator as (Navigator & { usb?: USB }) | undefined;
  return nav?.usb;
}

/** True when the browser already has permission for a tracker (connect needs no click). */
export async function tobiiDevicePermitted(usb: UsbLike | undefined = navigatorUsb()): Promise<boolean> {
  if (usb === undefined) return false;
  try {
    return (await usb.getDevices()).some(isTobii);
  } catch {
    return false;
  }
}

// --- stored device calibration ---------------------------------------------------

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Saves the tracker's calibration blob (base64). False when storage is unavailable or full. */
export function storeDeviceCalibration(blob: Uint8Array, storage: StorageLike | undefined = defaultStorage()): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(TOBII_CALIBRATION_KEY, toBase64(blob));
    return true;
  } catch {
    return false;
  }
}

/** The stored calibration blob, undefined when there is none or it is unreadable. */
export function loadDeviceCalibration(storage: StorageLike | undefined = defaultStorage()): Uint8Array | undefined {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(TOBII_CALIBRATION_KEY);
    if (raw === null || raw === "") return undefined;
    const blob = fromBase64(raw);
    return blob.length > 0 ? blob : undefined;
  } catch {
    return undefined;
  }
}

export function clearDeviceCalibration(storage: StorageLike | undefined = defaultStorage()): void {
  try {
    storage?.removeItem(TOBII_CALIBRATION_KEY);
  } catch {
    // ignore
  }
}

// --- error messages ------------------------------------------------------------------

function errName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const MSG_NO_WEBUSB =
  "WebUSB is not available. Use Chrome or Edge, and open stash over https or http://localhost.";
export const MSG_NEEDS_CLICK =
  "Click Connect to choose the eye tracker: the browser shows its USB device picker only after a click.";
export const MSG_NOT_CHOSEN = "No eye tracker chosen. Plug in the Tobii tracker and pick it in the browser's device list.";
export const MSG_IN_USE =
  "The eye tracker is in use by another program. On Windows, stop the Tobii services " +
  "(Tobii Service / Tobii Experience) so the browser can claim its USB interface, then connect again.";

/** Status message for a failure while picking the device. */
export function pickErrorMessage(e: unknown): string {
  const name = errName(e);
  if (name === "SecurityError" || /user gesture/i.test(errMessage(e))) return MSG_NEEDS_CLICK;
  if (name === "NotFoundError") return MSG_NOT_CHOSEN;
  return `Couldn't access USB devices: ${errMessage(e)}`;
}

/** Status message for a failure while opening/claiming the device or the handshake. */
export function openErrorMessage(e: unknown): string {
  const name = errName(e);
  const msg = errMessage(e);
  if (name === "SecurityError" || name === "NetworkError" || /claim|access denied|busy|in use/i.test(msg)) return MSG_IN_USE;
  return `The eye tracker failed to start: ${msg}`;
}

// --- source ------------------------------------------------------------------------------

function defaultScreenSize(): { width: number; height: number } {
  const s = globalThis.screen;
  const dpr = globalThis.devicePixelRatio || 1;
  return s === undefined ? { width: 1920, height: 1080 } : { width: s.width * dpr, height: s.height * dpr };
}

function displayMm(area: DisplayArea | null): { width: number; height: number } | undefined {
  if (area === null) return undefined;
  const d = (p: DisplayArea["tl"], q: DisplayArea["tl"]): number => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
  const width = d(area.tl, area.tr);
  const height = d(area.tl, area.bl);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

async function defaultSdk(): Promise<TobiiSdk> {
  return import("../../vendor/tobiifree/sdk/src/index.ts");
}

/** how long presence outlasts the last detected eye (closed eyes, blinks) */
export const PRESENCE_HOLD_MS = 4000;

export function createTobiiSource(opts: TobiiSourceOptions = {}): GazeSource {
  const now = opts.now ?? defaultNow;
  const screenSize = opts.screenSize ?? defaultScreenSize;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());

  const samples = createListeners<GazeSample>();
  const statuses = createListeners<GazeStatus>();
  const rate = createRateCounter();

  let st: GazeStatus = { kind: "tobii", connection: "disconnected" };
  let src: SdkSource | undefined;
  let device: USBDevice | undefined;
  let usb: UsbLike | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  /** bumped by disconnect so a connect in flight knows it was cancelled */
  let generation = 0;
  let lastStatusEmit = -Infinity;
  let lastEyeSeen = -Infinity;

  function setStatus(next: GazeStatus): void {
    st = next;
    lastStatusEmit = now();
    statuses.emit(status());
  }

  function status(): GazeStatus {
    const out: GazeStatus = { ...st };
    if (st.connection === "connected") out.rate = rate.rate(now());
    return out;
  }

  const onUsbDisconnect = (e: Event): void => {
    const d = (e as USBConnectionEvent).device;
    if (device !== undefined && d === device) {
      teardown();
      setStatus({ kind: "tobii", connection: "disconnected", message: "The eye tracker was unplugged." });
    }
  };

  function teardown(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    usb?.removeEventListener("disconnect", onUsbDisconnect);
    const s = src;
    src = undefined;
    device = undefined;
    rate.reset();
    if (s !== undefined) s.close().catch(() => {});
  }

  function onGaze(g: SdkGazeSample): void {
    const t = now();
    const norm = g.gaze_point_2d_norm;
    const eyeL = g.validity_L === 0;
    const eyeR = g.validity_R === 0;
    const hasNorm = norm !== undefined && Number.isFinite(norm.x) && Number.isFinite(norm.y);
    const size = screenSize();
    const valid = (eyeL || eyeR) && hasNorm;
    const x = hasNorm ? norm.x * size.width : Number.NaN;
    const y = hasNorm ? norm.y * size.height : Number.NaN;
    rate.add(t);
    samples.emit({ t, x, y, valid });

    // The tracker loses both eyes when they close, so "no eyes" alone would
    // read as the viewer leaving. Presence holds for a few seconds after the
    // last detected eye: closed eyes are "present without gaze", and only a
    // longer absence turns into "not present".
    if (eyeL || eyeR) lastEyeSeen = t;
    const present = eyeL || eyeR || t - lastEyeSeen <= PRESENCE_HOLD_MS;
    if (st.present !== present || st.tracking !== valid || t - lastStatusEmit >= 1000) {
      setStatus({ ...st, present, tracking: valid, screen: { x: 0, y: 0, width: size.width, height: size.height } });
    }
  }

  async function run(gen: number): Promise<void> {
    usb = opts.usb ?? navigatorUsb();
    if (usb === undefined) {
      setStatus({ kind: "tobii", connection: "error", message: MSG_NO_WEBUSB });
      return;
    }
    setStatus({ kind: "tobii", connection: "connecting", message: "Looking for the eye tracker…" });

    let dev: USBDevice;
    try {
      const known = (await usb.getDevices()).find(isTobii);
      dev = known ?? (await usb.requestDevice({ filters: TOBII_USB_FILTERS }));
    } catch (e) {
      if (gen === generation) setStatus({ kind: "tobii", connection: "error", message: pickErrorMessage(e) });
      return;
    }
    if (gen !== generation) return;

    setStatus({ kind: "tobii", connection: "connecting", message: "Starting the eye tracker…" });
    let s: SdkSource;
    try {
      const sdk = typeof opts.sdk === "function" ? await opts.sdk() : (opts.sdk ?? (await defaultSdk()));
      s = await sdk.Tobii.fromUsb({ device: dev });
    } catch (e) {
      if (gen === generation) setStatus({ kind: "tobii", connection: "error", message: openErrorMessage(e) });
      return;
    }
    if (gen !== generation) {
      s.close().catch(() => {});
      return;
    }

    src = s;
    device = dev;
    usb.addEventListener("disconnect", onUsbDisconnect);
    unsubscribe = s.subscribeToGaze(onGaze);

    const size = screenSize();
    const next: GazeStatus = {
      kind: "tobii",
      connection: "connected",
      screen: { x: 0, y: 0, width: size.width, height: size.height },
    };
    const mm = displayMm(s.displayArea);
    if (mm !== undefined) next.displayMm = mm;
    if (dev.productName) next.device = dev.productName;

    const blob = storage !== undefined ? loadDeviceCalibration(storage) : undefined;
    if (blob !== undefined) {
      try {
        await s.calApply(blob);
      } catch {
        next.message = "The stored tracker calibration couldn't be applied; please calibrate again.";
      }
      if (gen !== generation) return;
    }
    setStatus({ ...next, ...(st.present !== undefined ? { present: st.present } : {}), ...(st.tracking !== undefined ? { tracking: st.tracking } : {}) });
  }

  function requireSource(): SdkSource {
    if (src === undefined) throw new Error("The eye tracker is not connected");
    return src;
  }

  const deviceCalibration: DeviceCalibration = {
    // async so a missing connection rejects instead of throwing
    start: async () => requireSource().startCalibration(),
    addPoint: async (xNorm, yNorm) => requireSource().addCalibrationPoint(xNorm, yNorm),
    async finish() {
      const blob = await requireSource().finishCalibration();
      if (storage !== undefined) storeDeviceCalibration(blob, storage);
      return blob;
    },
    apply: async (blob) => requireSource().calApply(blob),
  };

  return {
    kind: "tobii",
    deviceCalibration,
    connect() {
      if (src !== undefined) return Promise.resolve();
      if (pending !== undefined) return pending;
      const gen = ++generation;
      // never rejects: failures end up in status()
      pending = run(gen)
        .catch((e: unknown) => {
          if (gen !== generation) return;
          teardown();
          setStatus({ kind: "tobii", connection: "error", message: openErrorMessage(e) });
        })
        .finally(() => {
          if (gen === generation) pending = undefined;
        });
      return pending;
    },
    disconnect() {
      generation++;
      pending = undefined;
      const was = st.connection;
      teardown();
      if (was !== "disconnected") setStatus({ kind: "tobii", connection: "disconnected" });
    },
    status,
    onSample: (cb) => samples.add(cb),
    onStatus: (cb) => statuses.add(cb),
  };
}

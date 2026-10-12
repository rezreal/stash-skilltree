import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTobiiSource,
  loadDeviceCalibration,
  MSG_IN_USE,
  MSG_NEEDS_CLICK,
  MSG_NO_WEBUSB,
  MSG_NOT_CHOSEN,
  storeDeviceCalibration,
  clearDeviceCalibration,
  tobiiDevicePermitted,
  TOBII_CALIBRATION_KEY,
} from "../../src/gaze/tobii.ts";
import type { StorageLike, TobiiSdk, UsbLike } from "../../src/gaze/tobii.ts";
import type { GazeSample, GazeStatus } from "../../src/gaze/types.ts";
import type { DisplayArea, GazeSample as SdkGazeSample, Source } from "../../vendor/tobiifree/sdk/src/index.ts";
import { FakeClock } from "./fakes.ts";

class FakeSdkSource implements Source {
  displayArea: DisplayArea | null = {
    tl: { x: -260, y: 300, z: 0 },
    tr: { x: 260, y: 300, z: 0 },
    bl: { x: -260, y: 10, z: 0 },
  };
  listeners = new Set<(s: SdkGazeSample) => void>();
  calls: string[] = [];
  closed = false;
  applyFails = false;
  subscribeToGaze(l: (s: SdkGazeSample) => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  emit(s: SdkGazeSample): void {
    for (const l of this.listeners) l(s);
  }
  async getDisplayArea(): Promise<DisplayArea> {
    return this.displayArea!;
  }
  async setDisplayArea(): Promise<void> {}
  async setDisplayAreaCorners(): Promise<void> {}
  async startCalibration(): Promise<void> {
    this.calls.push("start");
  }
  async addCalibrationPoint(x: number, y: number): Promise<void> {
    this.calls.push(`point ${x},${y}`);
  }
  async finishCalibration(): Promise<Uint8Array> {
    this.calls.push("finish");
    return new Uint8Array([1, 2, 3, 250]);
  }
  async calApply(blob: Uint8Array): Promise<void> {
    if (this.applyFails) throw new Error("bad blob");
    this.calls.push(`apply ${[...blob].join(",")}`);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

const DEVICE = { vendorId: 0x2104, productId: 0x0127, productName: "Tobii Eye Tracker 4C" } as unknown as USBDevice;
const OTHER = { vendorId: 0x1234, productId: 1 } as unknown as USBDevice;

class FakeUsb {
  devices: USBDevice[] = [];
  requestResult: USBDevice | Error = DEVICE;
  requests = 0;
  listeners = new Set<(e: Event) => void>();
  async getDevices(): Promise<USBDevice[]> {
    return this.devices;
  }
  async requestDevice(): Promise<USBDevice> {
    this.requests++;
    if (this.requestResult instanceof Error) throw this.requestResult;
    return this.requestResult;
  }
  addEventListener(type: string, l: (e: Event) => void): void {
    if (type === "disconnect") this.listeners.add(l);
  }
  removeEventListener(type: string, l: (e: Event) => void): void {
    if (type === "disconnect") this.listeners.delete(l);
  }
  unplug(device: USBDevice): void {
    for (const l of [...this.listeners]) l({ device } as unknown as Event);
  }
}

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

function setup(opts: { fromUsbError?: Error; storage?: StorageLike | null } = {}) {
  const clock = new FakeClock();
  const usb = new FakeUsb();
  const fake = new FakeSdkSource();
  const fromUsbCalls: (USBDevice | undefined)[] = [];
  const sdk: TobiiSdk = {
    Tobii: {
      async fromUsb(o) {
        fromUsbCalls.push(o?.device);
        if (opts.fromUsbError) throw opts.fromUsbError;
        return fake;
      },
    },
  };
  const storage = opts.storage === undefined ? new MemStorage() : opts.storage;
  const src = createTobiiSource({
    usb: usb as unknown as UsbLike,
    now: clock.now,
    screenSize: () => ({ width: 2560, height: 1440 }),
    sdk,
    storage,
  });
  const samples: GazeSample[] = [];
  const statuses: GazeStatus[] = [];
  src.onSample((s) => samples.push(s));
  src.onStatus((s) => statuses.push(s));
  return { clock, usb, fake, src, samples, statuses, fromUsbCalls, storage };
}

const gaze = (x: number, y: number, vL = 0, vR = 0): SdkGazeSample => ({
  validity_L: vL,
  validity_R: vR,
  gaze_point_2d_norm: { x, y },
});

describe("createTobiiSource", () => {
  it("reuses a permitted device without prompting", async () => {
    const { usb, src, fromUsbCalls } = setup();
    usb.devices = [OTHER, DEVICE];
    await src.connect();
    assert.equal(usb.requests, 0);
    assert.deepEqual(fromUsbCalls, [DEVICE]);
    const st = src.status();
    assert.equal(st.connection, "connected");
    assert.equal(st.kind, "tobii");
    assert.equal(st.device, "Tobii Eye Tracker 4C");
    assert.deepEqual(st.screen, { x: 0, y: 0, width: 2560, height: 1440 });
    assert.deepEqual(st.displayMm, { width: 520, height: 290 });
    assert.ok(src.deviceCalibration !== undefined);
  });

  it("prompts when no device is permitted yet", async () => {
    const { usb, src, statuses } = setup();
    await src.connect();
    assert.equal(usb.requests, 1);
    assert.equal(src.status().connection, "connected");
    assert.deepEqual(statuses.map((s) => s.connection), ["connecting", "connecting", "connected"]);
  });

  it("scales normalized gaze to screen px and derives validity", async () => {
    const { clock, fake, src, samples, statuses } = setup();
    await src.connect();
    clock.t = 100;
    fake.emit(gaze(0.5, 0.25));
    assert.deepEqual(samples.at(-1), { t: 100, x: 1280, y: 360, valid: true });
    assert.equal(statuses.at(-1)!.present, true);
    assert.equal(statuses.at(-1)!.tracking, true);
    fake.emit(gaze(0.1, 0.1, 4, 0)); // one eye is enough
    assert.equal(samples.at(-1)!.valid, true);
    fake.emit(gaze(0, 0, 4, 4));
    assert.equal(samples.at(-1)!.valid, false);
    assert.equal(statuses.at(-1)!.present, false);
    assert.equal(statuses.at(-1)!.tracking, false);
    fake.emit({ validity_L: 0, validity_R: 0 }); // eyes but no gaze point
    assert.equal(samples.at(-1)!.valid, false);
    assert.ok(Number.isNaN(samples.at(-1)!.x));
    assert.equal(src.status().present, true);
    assert.equal(src.status().tracking, false);
  });

  it("reports the sample rate over the last second", async () => {
    const { clock, fake, src } = setup();
    await src.connect();
    for (let i = 0; i < 90; i++) {
      clock.t = 1000 + i * 11;
      fake.emit(gaze(0.5, 0.5));
    }
    assert.ok(Math.abs(src.status().rate! - 90) <= 1, String(src.status().rate));
    clock.t += 2000;
    assert.equal(src.status().rate, 0);
  });

  it("explains a missing user gesture, a cancelled picker and no WebUSB", async () => {
    let t = setup();
    t.usb.requestResult = new DOMException("Must be handling a user gesture to show a permission request.", "SecurityError");
    await t.src.connect();
    assert.equal(t.src.status().connection, "error");
    assert.equal(t.src.status().message, MSG_NEEDS_CLICK);

    t = setup();
    t.usb.requestResult = new DOMException("No device selected.", "NotFoundError");
    await t.src.connect();
    assert.equal(t.src.status().message, MSG_NOT_CHOSEN);

    const noUsb = createTobiiSource({ sdk: { Tobii: { fromUsb: async () => new FakeSdkSource() } }, storage: null });
    await noUsb.connect();
    assert.equal(noUsb.status().connection, "error");
    assert.equal(noUsb.status().message, MSG_NO_WEBUSB);
  });

  it("explains a device claimed by the Tobii services", async () => {
    const t = setup({ fromUsbError: new DOMException("Unable to claim interface.", "NetworkError") });
    await t.src.connect();
    assert.equal(t.src.status().connection, "error");
    assert.equal(t.src.status().message, MSG_IN_USE);
    const u = setup({ fromUsbError: new Error("handshake failed") });
    await u.src.connect();
    assert.match(u.src.status().message!, /failed to start: handshake failed/);
  });

  it("goes disconnected when the tracker is unplugged", async () => {
    const { usb, fake, src, samples } = setup();
    usb.devices = [DEVICE];
    await src.connect();
    usb.unplug(OTHER);
    assert.equal(src.status().connection, "connected");
    usb.unplug(DEVICE);
    assert.equal(src.status().connection, "disconnected");
    assert.match(src.status().message!, /unplugged/);
    assert.equal(fake.closed, true);
    assert.equal(usb.listeners.size, 0);
    const n = samples.length;
    fake.emit(gaze(0.5, 0.5));
    assert.equal(samples.length, n);
  });

  it("disconnect closes the device and cancels a connect in flight", async () => {
    const { usb, fake, src } = setup();
    usb.devices = [DEVICE];
    await src.connect();
    src.disconnect();
    assert.equal(fake.closed, true);
    assert.equal(fake.listeners.size, 0);
    assert.equal(src.status().connection, "disconnected");

    const t = setup();
    t.usb.devices = [DEVICE];
    const p = t.src.connect();
    t.src.disconnect();
    await p;
    assert.equal(t.src.status().connection, "disconnected");
    assert.equal(t.fake.listeners.size, 0);
  });

  it("concurrent connects share one attempt", async () => {
    const { usb, src, fromUsbCalls } = setup();
    usb.devices = [DEVICE];
    await Promise.all([src.connect(), src.connect()]);
    await src.connect();
    assert.equal(fromUsbCalls.length, 1);
  });

  it("device calibration drives the SDK and stores the blob, applied on next connect", async () => {
    const storage = new MemStorage();
    const t = setup({ storage });
    t.usb.devices = [DEVICE];
    await assert.rejects(t.src.deviceCalibration!.start(), /not connected/);
    await t.src.connect();
    const cal = t.src.deviceCalibration!;
    await cal.start();
    await cal.addPoint(0.1, 0.9);
    const blob = await cal.finish();
    assert.deepEqual([...blob], [1, 2, 3, 250]);
    assert.deepEqual(t.fake.calls, ["start", "point 0.1,0.9", "finish"]);
    assert.deepEqual(loadDeviceCalibration(storage), blob);

    const u = setup({ storage });
    u.usb.devices = [DEVICE];
    await u.src.connect();
    assert.deepEqual(u.fake.calls, ["apply 1,2,3,250"]);
    assert.equal(u.src.status().message, undefined);
  });

  it("stays connected when the stored blob is rejected", async () => {
    const storage = new MemStorage();
    storeDeviceCalibration(new Uint8Array([9]), storage);
    const t = setup({ storage });
    t.usb.devices = [DEVICE];
    t.fake.applyFails = true;
    await t.src.connect();
    assert.equal(t.src.status().connection, "connected");
    assert.match(t.src.status().message!, /calibrate again/);
  });
});

describe("device calibration storage", () => {
  it("round-trips through base64", () => {
    const s = new MemStorage();
    const blob = new Uint8Array(70_000).map((_, i) => (i * 31) & 255);
    assert.equal(storeDeviceCalibration(blob, s), true);
    assert.match(s.getItem(TOBII_CALIBRATION_KEY)!, /^[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(loadDeviceCalibration(s), blob);
    clearDeviceCalibration(s);
    assert.equal(loadDeviceCalibration(s), undefined);
  });

  it("survives broken or missing storage", () => {
    const broken: StorageLike = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("quota"); },
      removeItem() { throw new Error("denied"); },
    };
    assert.equal(storeDeviceCalibration(new Uint8Array([1]), broken), false);
    assert.equal(loadDeviceCalibration(broken), undefined);
    clearDeviceCalibration(broken);
    assert.equal(storeDeviceCalibration(new Uint8Array([1]), undefined), false);
    assert.equal(loadDeviceCalibration(undefined), undefined);
    const garbage = new MemStorage();
    garbage.setItem(TOBII_CALIBRATION_KEY, "%%% not base64");
    assert.equal(loadDeviceCalibration(garbage), undefined);
  });
});

describe("tobiiDevicePermitted", () => {
  it("checks the permitted devices", async () => {
    const usb = new FakeUsb();
    assert.equal(await tobiiDevicePermitted(usb as unknown as UsbLike), false);
    usb.devices = [DEVICE];
    assert.equal(await tobiiDevicePermitted(usb as unknown as UsbLike), true);
    assert.equal(await tobiiDevicePermitted(undefined), false);
  });
});

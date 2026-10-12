import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBleDistanceSource,
  MSG_INSECURE,
  MSG_NEEDS_CLICK,
  MSG_NO_ADAPTER,
  MSG_NO_BLUETOOTH,
  MSG_NO_CONFIG,
  MSG_NOT_CHOSEN,
  MSG_PERMISSION_DENIED,
  MSG_PICK_AGAIN,
  MSG_POLICY,
  pickKnownDevice,
  requestOptions,
  SENSOR_DEVICE_KEY,
  sensorDevicePermitted,
} from "../../src/sensors/ble.ts";
import type { BleSensorConfig, DistanceSample, SensorStatus } from "../../src/track/types.ts";
import { FakeClock } from "../gaze/fakes.ts";
import {
  domError,
  FakeBluetooth,
  FakeCharacteristic,
  FakeDevice,
  FakeService,
  flush,
  MemStorage,
  props,
} from "./fakes.ts";

const CONFIG: BleSensorConfig = {
  service: "0xffe0",
  characteristic: "0xffe1",
  format: "uint16le",
  offset: 0,
  scale: 1,
};

function setup(opts: { config?: Partial<BleSensorConfig>; getDevices?: boolean; notify?: boolean } = {}) {
  const clock = new FakeClock();
  const ch = new FakeCharacteristic("0xffe1", props({ notify: opts.notify ?? true, read: true }));
  const dev = new FakeDevice("dev-1", "VL53 Reach", [new FakeService("0xffe0", [ch])]);
  const bt = new FakeBluetooth(dev, opts.getDevices ?? true);
  const storage = new MemStorage();
  const src = createBleDistanceSource(
    { ...CONFIG, ...opts.config },
    { bluetooth: bt, now: clock.now, timers: clock, storage, reconnectDelaysMs: [500, 1000, 4000] },
  );
  const samples: DistanceSample[] = [];
  const statuses: SensorStatus[] = [];
  src.onSample((s) => samples.push(s));
  src.onStatus((s) => statuses.push(s));
  return { clock, ch, dev, bt, storage, src, samples, statuses };
}

describe("createBleDistanceSource", () => {
  it("picks the device, subscribes and decodes notifications", async () => {
    const { bt, ch, src, samples, statuses, clock, storage } = setup();
    await src.connect();
    assert.equal(bt.requests.length, 1);
    assert.deepEqual(bt.requests[0], { acceptAllDevices: true, optionalServices: [0xffe0] });
    assert.ok(ch.notifying);
    const st = src.status();
    assert.equal(st.connection, "connected");
    assert.equal(st.device, "VL53 Reach");
    assert.deepEqual(statuses.map((s) => s.connection), ["connecting", "connecting", "connected"]);
    assert.equal(storage.getItem(SENSOR_DEVICE_KEY), "dev-1");

    clock.t = 50;
    ch.notify([0x2c, 0x01]);
    assert.deepEqual(samples, [{ t: 50, raw: 300 }]);
  });

  it("filters by name prefix when one is set", () => {
    assert.deepEqual(requestOptions({ namePrefix: " Reach" }, 0xffe0), {
      filters: [{ namePrefix: "Reach" }],
      optionalServices: [0xffe0],
    });
    assert.deepEqual(requestOptions({ namePrefix: "" }, "x"), { acceptAllDevices: true, optionalServices: ["x"] });
  });

  it("reuses a granted device without the picker", async () => {
    const { bt, dev, src, storage } = setup();
    bt.granted = [dev];
    dev.gatt.allowed = undefined;
    storage.setItem(SENSOR_DEVICE_KEY, "dev-1");
    await src.connect();
    assert.equal(bt.requests.length, 0);
    assert.equal(src.status().connection, "connected");
    assert.equal(await sensorDevicePermitted({}, { bluetooth: bt, storage }), true);
  });

  it("works without getDevices (feature-detected)", async () => {
    const { bt, src } = setup({ getDevices: false });
    await src.connect();
    assert.equal(bt.requests.length, 1);
    assert.equal(src.status().connection, "connected");
    assert.equal(await sensorDevicePermitted({}, { bluetooth: bt, storage: null }), false);
  });

  it("asks to pick again when a granted device lacks the service grant", async () => {
    const { bt, dev, src, storage } = setup();
    bt.granted = [dev];
    dev.gatt.allowed = new Set(); // granted earlier for another service
    await src.connect();
    assert.equal(src.status().connection, "error");
    assert.equal(src.status().message, MSG_PICK_AGAIN);
    assert.equal(storage.getItem(SENSOR_DEVICE_KEY), null);
    // the next connect (a click) opens the picker, which grants the service
    await src.connect();
    assert.equal(bt.requests.length, 1);
    assert.equal(src.status().connection, "connected");
  });

  it("reports the sample rate", async () => {
    const { clock, ch, src } = setup();
    await src.connect();
    for (let i = 0; i < 32; i++) {
      clock.t = 1000 + i * 30;
      ch.notify([100, 0]);
    }
    assert.ok(Math.abs(src.status().rate! - 32) <= 1, String(src.status().rate));
    clock.t += 3000;
    assert.equal(src.status().rate, 0);
  });

  it("skips notifications that don't decode and says so after a while", async () => {
    const { ch, src, samples } = setup();
    await src.connect();
    for (let i = 0; i < 10; i++) ch.notify([1]);
    assert.equal(samples.length, 0);
    assert.match(src.status().message ?? "", /doesn't decode as uint16le/);
    ch.notify([1, 0]);
    assert.equal(samples.length, 1);
    assert.equal(src.status().message, undefined);
  });

  it("reads ascii sensors", async () => {
    const { ch, src, samples } = setup({ config: { format: "ascii", scale: 0.1 } });
    await src.connect();
    ch.notify([..."1234\n"].map((c) => c.charCodeAt(0)));
    assert.equal(samples[0]!.raw, 123.4);
  });

  it("reconnects with backoff after the link drops, while wanted", async () => {
    const { clock, dev, ch, src, statuses } = setup();
    await src.connect();
    dev.gatt.connectError = domError("NetworkError", "Connection failed for unknown reason.");
    dev.gatt.drop();
    assert.equal(src.status().connection, "connecting");
    assert.match(src.status().message ?? "", /Reconnecting/);
    clock.advance(500);
    await flush();
    assert.equal(dev.gatt.connects, 2);
    assert.match(src.status().message ?? "", /attempt 2 in 1 s/);
    clock.advance(1000);
    await flush();
    assert.equal(dev.gatt.connects, 3);
    dev.gatt.connectError = undefined;
    clock.advance(4000);
    await flush();
    assert.equal(dev.gatt.connects, 4);
    assert.equal(src.status().connection, "connected");
    assert.ok(ch.notifying);
    assert.equal(statuses.at(-1)!.connection, "connected");
    // backoff restarts after a successful reconnect
    dev.gatt.drop();
    clock.advance(500);
    await flush();
    assert.equal(src.status().connection, "connected");
  });

  it("stops reconnecting on disconnect()", async () => {
    const { clock, dev, src } = setup();
    await src.connect();
    dev.gatt.connectError = domError("NetworkError");
    dev.gatt.drop();
    src.disconnect();
    assert.equal(src.status().connection, "disconnected");
    assert.equal(clock.pending, 0);
    clock.advance(10_000);
    await flush();
    assert.equal(dev.gatt.connects, 1);
  });

  it("disconnect() stops notifications and closes GATT", async () => {
    const { dev, ch, src, statuses } = setup();
    await src.connect();
    src.disconnect();
    await flush();
    assert.equal(ch.notifying, false);
    assert.equal(dev.gatt.connected, false);
    assert.equal(ch.count("characteristicvaluechanged"), 0);
    assert.equal(dev.count("gattserverdisconnected"), 0);
    assert.equal(statuses.at(-1)!.connection, "disconnected");
  });

  it("never rejects and explains picker failures", async () => {
    const cases: [Error, string][] = [
      [domError("SecurityError", "Must be handling a user gesture to show a permission request."), MSG_NEEDS_CLICK],
      [domError("NotFoundError", "User cancelled the requestDevice() chooser."), MSG_NOT_CHOSEN],
      [domError("NotFoundError", "Bluetooth adapter not available."), MSG_NO_ADAPTER],
      [domError("NotAllowedError", "Bluetooth permission has been blocked."), MSG_PERMISSION_DENIED],
      [domError("SecurityError", 'Access to the feature "bluetooth" is disallowed by permissions policy.'), MSG_POLICY],
    ];
    for (const [err, msg] of cases) {
      const t = setup();
      t.bt.requestResult = err;
      await t.src.connect();
      assert.equal(t.src.status().connection, "error");
      assert.equal(t.src.status().message, msg, err.message);
    }
  });

  it("explains a missing service or characteristic", async () => {
    let t = setup({ config: { service: "0x181a" } });
    await t.src.connect();
    assert.equal(t.src.status().connection, "error");
    assert.match(t.src.status().message!, /has no service 0x181a.*Find my sensor/);
    assert.equal(t.dev.gatt.connected, false);

    t = setup({ config: { characteristic: "0x2a00" } });
    await t.src.connect();
    assert.match(t.src.status().message!, /no characteristic 0x2a00.*Find my sensor/);

    t = setup({ notify: false });
    await t.src.connect();
    assert.match(t.src.status().message!, /doesn't send notifications/);
  });

  it("explains missing configuration, bad UUIDs and no Web Bluetooth", async () => {
    let t = setup({ config: { service: "" } });
    await t.src.connect();
    assert.equal(t.src.status().message, MSG_NO_CONFIG);
    assert.equal(t.bt.requests.length, 0);

    t = setup({ config: { characteristic: "not a uuid" } });
    await t.src.connect();
    assert.match(t.src.status().message!, /characteristic UUID “not a uuid” is not valid/);

    const src = createBleDistanceSource(CONFIG, { bluetooth: undefined, storage: null, secureContext: true });
    await src.connect();
    assert.equal(src.status().message, MSG_NO_BLUETOOTH);
    const insecure = createBleDistanceSource(CONFIG, { storage: null, secureContext: false });
    await insecure.connect();
    assert.equal(insecure.status().message, MSG_INSECURE);
  });
});

describe("pickKnownDevice", () => {
  const a = { id: "a", name: "Reach 1" };
  const b = { id: "b", name: "HR strap" };
  it("prefers the remembered device, then the name prefix, then a single grant", () => {
    assert.equal(pickKnownDevice([a, b], "b", "Reach"), b);
    assert.equal(pickKnownDevice([a, b], "zz", "Reach"), a);
    assert.equal(pickKnownDevice([b], undefined, "Reach"), undefined);
    assert.equal(pickKnownDevice([b], undefined, undefined), b);
    assert.equal(pickKnownDevice([a, b], undefined, undefined), undefined);
  });
});

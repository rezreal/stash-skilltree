import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  choiceFrom,
  COMMON_SERVICES,
  discoverCharacteristics,
  discoveryServices,
  serviceName,
  splitUuidList,
} from "../../src/sensors/discover.ts";
import { MSG_NO_BLUETOOTH, MSG_NOT_CHOSEN } from "../../src/sensors/ble.ts";
import { FakeClock } from "../gaze/fakes.ts";
import { domError, FakeBluetooth, FakeCharacteristic, FakeDevice, FakeService, flush, props } from "./fakes.ts";

const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

function device() {
  const dist = new FakeCharacteristic("0xffe1", props({ notify: true }));
  const name = new FakeCharacteristic("0x2a00", props({ read: true }));
  name.readResult = new DataView(new Uint8Array(text("Reach")).buffer);
  const vendor = new FakeCharacteristic("12345678-1234-1234-1234-123456789abc", props({ notify: true, read: true }));
  vendor.readResult = domError("NotSupportedError", "GATT operation not permitted.");
  const dev = new FakeDevice("d1", "Reach", [
    new FakeService("0xffe0", [dist]),
    new FakeService("0x1800", [name]),
    new FakeService("abcdef01-0000-1000-8000-00805f9b34fb", [vendor]),
  ]);
  return { dev, dist, name, vendor };
}

describe("discoveryServices", () => {
  it("adds valid user UUIDs once and reports invalid ones", () => {
    const { services, invalid } = discoveryServices(["0xffe0", "abcdef01-0000-1000-8000-00805f9b34fb", "nope!", " "]);
    assert.equal(services.length, COMMON_SERVICES.length + 1);
    assert.ok(services.includes("abcdef01-0000-1000-8000-00805f9b34fb"));
    assert.deepEqual(invalid, ["nope!"]);
    assert.deepEqual(splitUuidList("0xffe0, 0xfff0;\n abcd"), ["0xffe0", "0xfff0", "abcd"]);
  });

  it("names common services", () => {
    assert.match(serviceName("0000ffe0-0000-1000-8000-00805f9b34fb")!, /HM-10/);
    assert.equal(serviceName("0000aaaa-0000-1000-8000-00805f9b34fb"), undefined);
  });
});

describe("discoverCharacteristics", () => {
  it("lists reachable services, samples notifications and ranks decodings", async () => {
    const clock = new FakeClock();
    const { dev, dist } = device();
    dist.onStart = () => {
      dist.notify(text("120\n"));
      dist.notify(text("180\n"));
      dist.notify(text("95\n"));
    };
    const bt = new FakeBluetooth(dev);
    const progress: string[] = [];
    const p = discoverCharacteristics({
      bluetooth: bt,
      timers: clock,
      sampleMs: 1000,
      extraServices: ["abcdef01-0000-1000-8000-00805f9b34fb"],
      onProgress: (m) => progress.push(m),
    });
    let done = false;
    void p.then(() => (done = true));
    for (let i = 0; i < 10 && !done; i++) {
      await flush();
      clock.advance(1000);
    }
    const r = await p;

    assert.equal(r.error, undefined);
    assert.deepEqual(r.device, { id: "d1", name: "Reach" });
    assert.equal(bt.requests[0]!.acceptAllDevices, true);
    // 0x1800 was not requested, so the browser hides it
    assert.deepEqual(r.services.map((s) => s.short), ["0xffe0", "0xabcdef01"]);
    const ch = r.services[0]!.characteristics[0]!;
    assert.equal(ch.short, "0xffe1");
    assert.deepEqual(ch.properties, { read: false, notify: true, indicate: false, write: false });
    assert.deepEqual(ch.samples.map((s) => s.ascii), ["120\\n", "180\\n", "95\\n"]);
    assert.equal(ch.samples[0]!.hex, "31 32 30 0a");
    assert.equal(ch.candidates[0]!.format, "ascii");
    assert.deepEqual(choiceFrom(r.services[0]!, ch), { service: "0xffe0", characteristic: "0xffe1", format: "ascii", offset: 0 });

    const vendor = r.services[1]!.characteristics[0]!;
    assert.deepEqual(vendor.samples, []);
    assert.match(vendor.error!, /read: GATT operation not permitted/);
    assert.equal(dev.gatt.connected, false);
    assert.ok(progress.some((m) => /move the sensor/.test(m)));
  });

  it("explains when no requested service exists", async () => {
    const dev = new FakeDevice("d2", "Odd", [new FakeService("0000aaaa-0000-1000-8000-00805f9b34fb", [])]);
    const r = await discoverCharacteristics({ bluetooth: new FakeBluetooth(dev), timers: new FakeClock() });
    assert.match(r.error!, /Enter the sensor's service UUID/);
    assert.equal(dev.gatt.connected, false);
  });

  it("never rejects on picker failures or without Web Bluetooth", async () => {
    const bt = new FakeBluetooth(domError("NotFoundError", "User cancelled the requestDevice() chooser."));
    assert.equal((await discoverCharacteristics({ bluetooth: bt })).error, MSG_NOT_CHOSEN);
    assert.equal((await discoverCharacteristics({ secureContext: true })).error, MSG_NO_BLUETOOTH);
  });
});

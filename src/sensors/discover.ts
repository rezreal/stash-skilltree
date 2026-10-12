// "Find my sensor": lists what a Bluetooth device offers so the user can
// tell which characteristic carries the distance. The user picks any device;
// we connect, walk the services and characteristics, sample a few
// notifications from every notify characteristic (and read the readable
// ones once) and rank candidate decodings of the bytes.
//
// Limitation of Web Bluetooth: a page only sees the services it named in
// optionalServices when the device was picked. There is no "list all
// services" without that list, so we ask for a set of common ones (below)
// plus whatever UUIDs the user types. A sensor with an unusual vendor
// service shows nothing until its UUID is entered (it is often printed in
// the sensor's docs, or visible in a phone app such as nRF Connect).
import type { ValueFormat } from "../track/types.ts";
import { GLOBAL_TIMERS, type Timers } from "../gaze/rate.ts";
import type {
  Bluetooth,
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTService,
  BluetoothServiceUUID,
} from "./bluetooth.d.ts";
import { MSG_INSECURE, MSG_NO_BLUETOOTH, bluetoothAvailable, pickErrorMessage } from "./ble.ts";
import { asciiPreview, hexBytes, normalizeUuid, rankDecodings, shortUuid, type RankedDecoding } from "./value.ts";

/** Services requested for discovery: standard ones and those hobby/serial BLE modules use. */
export const COMMON_SERVICES: { uuid: BluetoothServiceUUID; name: string }[] = [
  { uuid: 0x180a, name: "Device Information" },
  { uuid: 0x180f, name: "Battery" },
  { uuid: 0x181a, name: "Environmental Sensing" },
  { uuid: 0x1815, name: "Automation IO" },
  { uuid: 0x1819, name: "Location and Navigation" },
  { uuid: 0xffe0, name: "HM-10 / JDY serial (char 0xffe1)" },
  { uuid: 0xfff0, name: "Vendor serial 0xfff0" },
  { uuid: 0xffb0, name: "Vendor 0xffb0" },
  { uuid: 0xff00, name: "Vendor 0xff00" },
  { uuid: 0xfee0, name: "Vendor 0xfee0" },
  { uuid: "6e400001-b5a3-f393-e0a9-e50e24dcca9e", name: "Nordic UART (ESP32/nRF serial)" },
  { uuid: "4fafc201-1fb5-459e-8fcc-c5c9c331914b", name: "ESP32 BLE example service" },
  { uuid: "19b10000-e8f2-537e-4f6c-d104768a1214", name: "Arduino BLE example service" },
  { uuid: "0000fe59-0000-1000-8000-00805f9b34fb", name: "Nordic DFU" },
];

const KNOWN_CHARACTERISTICS: Record<string, string> = {
  "0x2a00": "Device Name",
  "0x2a19": "Battery Level",
  "0x2a24": "Model Number",
  "0x2a25": "Serial Number",
  "0x2a26": "Firmware Revision",
  "0x2a29": "Manufacturer Name",
  "0x2a6e": "Temperature",
  "0x2a6f": "Humidity",
  "0x2a56": "Digital",
  "0x2a58": "Analog",
  "0xffe1": "HM-10 serial data",
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e": "Nordic UART RX (write)",
  "6e400003-b5a3-f393-e0a9-e50e24dcca9e": "Nordic UART TX (notify)",
};

export function serviceName(uuid: string): string | undefined {
  const s = shortUuid(uuid);
  return COMMON_SERVICES.find((c) => (typeof c.uuid === "number" ? `0x${c.uuid.toString(16).padStart(4, "0")}` : c.uuid) === s)
    ?.name;
}

export function characteristicName(uuid: string): string | undefined {
  return KNOWN_CHARACTERISTICS[shortUuid(uuid)];
}

export interface DiscoveredCharacteristic {
  /** full UUID as the browser reports it */
  uuid: string;
  /** 0xffe1 for base UUIDs, else the full UUID */
  short: string;
  name?: string;
  properties: { read: boolean; notify: boolean; indicate: boolean; write: boolean };
  /** notifications received while sampling, then the read value if any */
  samples: { hex: string; ascii: string }[];
  /** ranked candidate decodings of the samples (best first, top few) */
  candidates: RankedDecoding[];
  error?: string;
}

export interface DiscoveredService {
  uuid: string;
  short: string;
  name?: string;
  characteristics: DiscoveredCharacteristic[];
  error?: string;
}

export interface DiscoveryResult {
  device?: { id: string; name?: string };
  services: DiscoveredService[];
  /** set when nothing could be listed */
  error?: string;
  /** user-entered service UUIDs that were not valid */
  invalid: string[];
}

export interface DiscoverOptions {
  bluetooth?: Bluetooth;
  /** user-entered service UUIDs to request as well */
  extraServices?: string[];
  /** how long to listen to notifications, default 2500 ms */
  sampleMs?: number;
  /** most notifications kept per characteristic, default 8 */
  maxSamples?: number;
  /** most candidate decodings returned per characteristic, default 4 */
  maxCandidates?: number;
  /** progress text for the UI */
  onProgress?: (message: string) => void;
  timers?: Timers;
  secureContext?: boolean;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function navigatorBluetooth(): Bluetooth | undefined {
  return (globalThis.navigator as (Navigator & { bluetooth?: Bluetooth }) | undefined)?.bluetooth;
}

/** the optionalServices list: common services plus valid user entries, without duplicates */
export function discoveryServices(extra: string[] = []): { services: BluetoothServiceUUID[]; invalid: string[] } {
  const services: BluetoothServiceUUID[] = COMMON_SERVICES.map((s) => s.uuid);
  const invalid: string[] = [];
  for (const raw of extra) {
    const t = raw.trim();
    if (!t) continue;
    const u = normalizeUuid(t);
    if (u === undefined) invalid.push(t);
    else if (!services.includes(u)) services.push(u);
  }
  return { services, invalid };
}

/** splits a typed list of UUIDs ("0xffe0, 6e40…  abcd") */
export function splitUuidList(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wait(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

async function sampleCharacteristic(
  ch: BluetoothRemoteGATTCharacteristic,
  opts: Required<Pick<DiscoverOptions, "sampleMs" | "maxSamples" | "maxCandidates">> & { timers: Timers },
): Promise<DiscoveredCharacteristic> {
  const p = ch.properties;
  const out: DiscoveredCharacteristic = {
    uuid: ch.uuid,
    short: shortUuid(ch.uuid),
    properties: { read: p.read, notify: p.notify, indicate: p.indicate, write: p.write || p.writeWithoutResponse },
    samples: [],
    candidates: [],
  };
  const name = characteristicName(ch.uuid);
  if (name) out.name = name;
  const views: DataView[] = [];
  const keep = (dv: DataView | null | undefined) => {
    if (!dv || views.length >= opts.maxSamples) return;
    // copy: the browser may reuse the buffer
    const copy = new DataView(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    views.push(copy);
  };
  const errors: string[] = [];
  if (p.notify || p.indicate) {
    const onValue = () => keep(ch.value);
    ch.addEventListener("characteristicvaluechanged", onValue);
    try {
      await ch.startNotifications();
      await wait(opts.timers, opts.sampleMs);
      await ch.stopNotifications().catch(() => undefined);
    } catch (e) {
      errors.push(`notifications: ${errMessage(e)}`);
    } finally {
      ch.removeEventListener("characteristicvaluechanged", onValue);
    }
  }
  if (p.read) {
    try {
      keep(await ch.readValue());
    } catch (e) {
      errors.push(`read: ${errMessage(e)}`);
    }
  }
  out.samples = views.map((v) => ({ hex: hexBytes(v), ascii: asciiPreview(v) }));
  if (views.length > 0) out.candidates = rankDecodings(views).filter((d) => d.score > 0).slice(0, opts.maxCandidates);
  if (errors.length) out.error = errors.join("; ");
  return out;
}

async function walkService(
  svc: BluetoothRemoteGATTService,
  opts: Parameters<typeof sampleCharacteristic>[1],
): Promise<DiscoveredService> {
  const out: DiscoveredService = { uuid: svc.uuid, short: shortUuid(svc.uuid), characteristics: [] };
  const name = serviceName(svc.uuid);
  if (name) out.name = name;
  let chars: BluetoothRemoteGATTCharacteristic[];
  try {
    chars = await svc.getCharacteristics();
  } catch (e) {
    out.error = `Couldn't list characteristics: ${errMessage(e)}`;
    return out;
  }
  // all characteristics sample in parallel so the wait is paid once
  out.characteristics = await Promise.all(chars.map((c) => sampleCharacteristic(c, opts)));
  return out;
}

/**
 * Opens the browser's Bluetooth picker (call from a click), then lists the
 * picked device's reachable services and characteristics with sampled
 * values. Never rejects: failures end up in `error`. The GATT connection is
 * closed afterwards; disconnect the track sensor before running this on the
 * same device.
 */
export async function discoverCharacteristics(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const progress = opts.onProgress ?? (() => undefined);
  const { services, invalid } = discoveryServices(opts.extraServices);
  const result: DiscoveryResult = { services: [], invalid };
  const bt = opts.bluetooth ?? navigatorBluetooth();
  if (!bluetoothAvailable(bt)) {
    const secure = opts.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext;
    result.error = secure === false ? MSG_INSECURE : MSG_NO_BLUETOOTH;
    return result;
  }
  let device: BluetoothDevice;
  try {
    progress("Pick the sensor in the browser's Bluetooth list…");
    device = await bt!.requestDevice({ acceptAllDevices: true, optionalServices: services });
  } catch (e) {
    result.error = pickErrorMessage(e);
    return result;
  }
  result.device = { id: device.id, ...(device.name ? { name: device.name } : {}) };
  const gatt = device.gatt;
  if (!gatt) {
    result.error = "This device has no GATT server (it only advertises), so it can't stream values.";
    return result;
  }
  try {
    progress(`Connecting to ${device.name || "the device"}…`);
    const server = await gatt.connect();
    let list: BluetoothRemoteGATTService[];
    try {
      list = await server.getPrimaryServices();
    } catch (e) {
      result.error =
        `None of the requested services were found on ${device.name || "this device"} (${errMessage(e)}). ` +
        "Enter the sensor's service UUID and try again: browsers only show services the page asks for.";
      return result;
    }
    progress(`Sampling ${list.length} service${list.length === 1 ? "" : "s"}: move the sensor now…`);
    const sampleOpts = {
      sampleMs: opts.sampleMs ?? 2500,
      maxSamples: opts.maxSamples ?? 8,
      maxCandidates: opts.maxCandidates ?? 4,
      timers,
    };
    // services (and their characteristics) sample in parallel: one wait in total
    result.services = await Promise.all(list.map((svc) => walkService(svc, sampleOpts)));
    return result;
  } catch (e) {
    result.error = `Couldn't read the device: ${errMessage(e)}`;
    return result;
  } finally {
    try {
      if (gatt.connected) gatt.disconnect();
    } catch {
      // ignore
    }
  }
}

/** The settings a discovered characteristic suggests (best candidate decoding). */
export interface SensorChoice {
  service: string;
  characteristic: string;
  format: ValueFormat;
  offset: number;
}

export function choiceFrom(service: DiscoveredService, ch: DiscoveredCharacteristic, candidate?: RankedDecoding): SensorChoice {
  const best = candidate ?? ch.candidates[0];
  return {
    service: service.short,
    characteristic: ch.short,
    format: best?.format ?? "uint16le",
    offset: best?.offset ?? 0,
  };
}

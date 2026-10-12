// The distance sensor over Web Bluetooth: pick (or reuse) the device,
// connect GATT, subscribe to the configured characteristic and decode each
// notification into a DistanceSample. Same shape as the gaze sources
// (src/gaze/tobii.ts): globals are injectable, connect() never rejects,
// failures end up in status() with a message that says what to do.
//
// Web Bluetooth notes:
// - requestDevice() needs a user gesture (a click on Connect).
// - navigator.bluetooth.getDevices() lists devices this origin was granted
//   earlier; Chrome ships it behind chrome://flags/#enable-web-bluetooth-new-
//   permissions-backend on some platforms, so it is feature-detected. With
//   it, a sensor picked on an earlier visit connects without a click.
// - A service is only reachable when it was named in the requestDevice()
//   call that granted the device (filters/optionalServices). A device granted
//   for another service has to be picked again.
// - Only in secure contexts (https or http://localhost) and Chromium browsers.
import type { BleSensorConfig, DistanceSample, DistanceSource, SensorStatus } from "../track/types.ts";
import { GLOBAL_TIMERS, createListeners, createRateCounter, defaultNow, type Timers } from "../gaze/rate.ts";
import type {
  Bluetooth,
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothServiceUUID,
  RequestDeviceOptions,
} from "./bluetooth.d.ts";
import { normalizeUuid, parseValue, shortUuid } from "./value.ts";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BleSourceOptions {
  /** default navigator.bluetooth */
  bluetooth?: Bluetooth;
  now?: () => number;
  timers?: Timers;
  /** remembers the chosen device id; null = don't. Default localStorage */
  storage?: StorageLike | null;
  /** reconnect delays in ms after the sensor drops; the last one repeats */
  reconnectDelaysMs?: number[];
  /** default window.isSecureContext */
  secureContext?: boolean;
}

export const SENSOR_DEVICE_KEY = "skilltree.sensorDevice";
export const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];
/** consecutive notifications that don't decode before the status says so */
const BAD_VALUES_WARN = 10;

// --- messages ---------------------------------------------------------------------

export const MSG_NO_BLUETOOTH =
  "Web Bluetooth is not available. Use Chrome or Edge on desktop or Android (not Firefox or Safari), " +
  "and open stash over https or http://localhost.";
export const MSG_INSECURE =
  "Web Bluetooth only works on secure pages: open stash over https (or http://localhost).";
export const MSG_NO_CONFIG =
  "No sensor configured. Set the service and characteristic in Settings › Plugins › Skilltree, " +
  "or use “Find my sensor” on the sensor page.";
export const MSG_NEEDS_CLICK = "Click Connect to choose the sensor: the browser shows its Bluetooth picker only after a click.";
export const MSG_NOT_CHOSEN = "No sensor chosen. Switch the sensor on, keep it close and pick it in the browser's Bluetooth list.";
export const MSG_NO_ADAPTER = "Bluetooth is off or this computer has no Bluetooth adapter. Turn Bluetooth on and try again.";
export const MSG_PERMISSION_DENIED =
  "The browser blocked Bluetooth for this site. Allow it in the site settings (the icon left of the address bar) and try again.";
export const MSG_POLICY =
  "Bluetooth is disallowed on this page by a permissions policy (e.g. stash runs inside a frame or behind a proxy " +
  "that sends Permissions-Policy: bluetooth=()).";
export const MSG_PICK_AGAIN =
  "The browser hasn't granted this sensor's service to the site yet. Click Connect and pick the sensor again.";

export function msgServiceNotFound(service: string, device?: string): string {
  return (
    `The sensor${device ? ` “${device}”` : ""} has no service ${service}. ` +
    "Check the service UUID in the plugin settings, or use “Find my sensor” to see which services it offers."
  );
}

export function msgCharacteristicNotFound(characteristic: string, service: string): string {
  return (
    `Service ${service} has no characteristic ${characteristic}. ` +
    "Check the characteristic UUID in the plugin settings, or use “Find my sensor” to list them."
  );
}

export function msgNoNotify(characteristic: string): string {
  return (
    `Characteristic ${characteristic} doesn't send notifications and can't be read, so it carries no distances. ` +
    "Use “Find my sensor” to find one marked notify or read."
  );
}

export function msgBadUuid(what: string, value: string): string {
  return `The sensor ${what} UUID “${value}” is not valid. Use a full UUID or a short one like 0xffe0.`;
}

function errName(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

/** Status message for a failure of requestDevice() (picking the sensor). */
export function pickErrorMessage(e: unknown): string {
  const name = errName(e);
  const msg = errMessage(e);
  if (/user gesture/i.test(msg)) return MSG_NEEDS_CLICK;
  if (/permissions? policy|disallowed/i.test(msg)) return MSG_POLICY;
  if (/adapter|bluetooth (is )?(turned )?off|radio/i.test(msg)) return MSG_NO_ADAPTER;
  if (name === "NotFoundError") return MSG_NOT_CHOSEN;
  if (name === "NotAllowedError" || name === "SecurityError") return MSG_PERMISSION_DENIED;
  if (name === "TypeError" || e instanceof TypeError) return `The sensor settings are not valid: ${msg}`;
  return `Couldn't open the Bluetooth picker: ${msg}`;
}

// --- helpers ------------------------------------------------------------------------

function navigatorBluetooth(): Bluetooth | undefined {
  const nav = globalThis.navigator as (Navigator & { bluetooth?: Bluetooth }) | undefined;
  return nav?.bluetooth;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function readStored(storage: StorageLike | undefined): string | undefined {
  try {
    return storage?.getItem(SENSOR_DEVICE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function writeStored(storage: StorageLike | undefined, id: string | undefined): void {
  try {
    if (id) storage?.setItem(SENSOR_DEVICE_KEY, id);
    else storage?.removeItem(SENSOR_DEVICE_KEY);
  } catch {
    // not remembered: the next visit asks again
  }
}

function label(u: BluetoothServiceUUID): string {
  return typeof u === "number" ? `0x${u.toString(16).padStart(4, "0")}` : shortUuid(u);
}

/** The requestDevice() options for a config: a name filter when one is set, else every device. */
export function requestOptions(config: Pick<BleSensorConfig, "namePrefix">, service: BluetoothServiceUUID): RequestDeviceOptions {
  const prefix = config.namePrefix?.trim();
  return prefix
    ? { filters: [{ namePrefix: prefix }], optionalServices: [service] }
    : { acceptAllDevices: true, optionalServices: [service] };
}

/**
 * Which of the already-granted devices is the sensor: the one remembered
 * from the last connect, else the first whose name has the prefix, else the
 * only granted device. Undefined when it is ambiguous or none fits.
 */
export function pickKnownDevice<D extends { id: string; name?: string | null }>(
  devices: D[],
  rememberedId: string | undefined,
  namePrefix: string | undefined,
): D | undefined {
  if (rememberedId) {
    const hit = devices.find((d) => d.id === rememberedId);
    if (hit) return hit;
  }
  const prefix = namePrefix?.trim();
  if (prefix) return devices.find((d) => (d.name ?? "").startsWith(prefix));
  return devices.length === 1 ? devices[0] : undefined;
}

/** True when a sensor was granted on an earlier visit, so connect() needs no click. */
export async function sensorDevicePermitted(
  config: Pick<BleSensorConfig, "namePrefix">,
  opts: { bluetooth?: Bluetooth; storage?: StorageLike | null } = {},
): Promise<boolean> {
  const bt = opts.bluetooth ?? navigatorBluetooth();
  if (!bt || typeof bt.getDevices !== "function") return false;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());
  try {
    return pickKnownDevice(await bt.getDevices(), readStored(storage), config.namePrefix) !== undefined;
  } catch {
    return false;
  }
}

/** Web Bluetooth exists in this browser (it may still be off or blocked). */
export function bluetoothAvailable(bt: Bluetooth | undefined = navigatorBluetooth()): boolean {
  return bt !== undefined && typeof bt.requestDevice === "function";
}

/** Thrown inside run() for a failure with a ready status message. */
class Failure extends Error {
  readonly retry: boolean;
  constructor(message: string, retry = false) {
    super(message);
    this.retry = retry;
  }
}

// --- source -----------------------------------------------------------------------

/** shortest time between two reads when a read-only characteristic is polled (25 Hz) */
export const POLL_MS = 40;

export function createBleDistanceSource(config: BleSensorConfig, opts: BleSourceOptions = {}): DistanceSource {
  const now = opts.now ?? defaultNow;
  const timers = opts.timers ?? GLOBAL_TIMERS;
  const storage = opts.storage === null ? undefined : (opts.storage ?? defaultStorage());
  const delays = opts.reconnectDelaysMs?.length ? opts.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;

  const samples = createListeners<DistanceSample>();
  const statuses = createListeners<SensorStatus>();
  const rate = createRateCounter();

  let st: SensorStatus = { connection: "disconnected" };
  /** connect() was called and disconnect() wasn't: keep reconnecting */
  let wanted = false;
  let device: BluetoothDevice | undefined;
  let characteristic: BluetoothRemoteGATTCharacteristic | undefined;
  /** the device lost the grant for our service: the next connect opens the picker */
  let mustPick = false;
  let pending: Promise<void> | undefined;
  let generation = 0;
  let retryTimer: unknown;
  let attempt = 0;
  let badValues = 0;
  let lastStatusEmit = -Infinity;

  function deviceName(): string | undefined {
    return device?.name || undefined;
  }

  function setStatus(next: SensorStatus): void {
    st = next;
    lastStatusEmit = now();
    statuses.emit(status());
  }

  function status(): SensorStatus {
    const out: SensorStatus = { ...st };
    if (st.connection === "connected") out.rate = rate.rate(now());
    return out;
  }

  function fail(message: string): void {
    setStatus({ connection: "error", message, ...(deviceName() ? { device: deviceName()! } : {}) });
  }

  /** notifications: the new value sits on the characteristic */
  const onValue = (): void => {
    handleValue(characteristic?.value ?? undefined);
  };

  function handleValue(dv: DataView | undefined): void {
    if (!dv) return;
    const t = now();
    const raw = parseValue(dv, config.format, config.offset, config.scale);
    if (raw === undefined) {
      badValues++;
      if (badValues === BAD_VALUES_WARN) {
        setStatus({
          ...st,
          message: `The sensor's data doesn't decode as ${config.format} at offset ${config.offset}. Check the format in the plugin settings.`,
        });
      }
      return;
    }
    if (badValues >= BAD_VALUES_WARN) {
      const { message: _m, ...rest } = st;
      st = rest;
    }
    badValues = 0;
    rate.add(t);
    samples.emit({ t, raw });
    if (t - lastStatusEmit >= 1000) setStatus(st);
  }

  const onGattDisconnected = (): void => {
    detachCharacteristic(false);
    rate.reset();
    if (!wanted) {
      // an error status (set before the disconnect was requested) stays
      if (st.connection === "connected" || st.connection === "connecting") {
        setStatus({ connection: "disconnected", ...(deviceName() ? { device: deviceName()! } : {}) });
      }
      return;
    }
    scheduleReconnect();
  };

  /** polling generation: bumping it ends the read loop */
  let pollGen = 0;
  let polling = false;

  function detachCharacteristic(stop: boolean): void {
    const c = characteristic;
    characteristic = undefined;
    pollGen++;
    const wasPolling = polling;
    polling = false;
    if (!c) return;
    c.removeEventListener("characteristicvaluechanged", onValue);
    if (stop && !wasPolling) c.stopNotifications().catch(() => undefined);
  }

  /**
   * For sensors whose value can only be read: read again as soon as the last
   * read returns, at most every POLL_MS. Reads never overlap. A failing read
   * ends the loop; the GATT disconnect handling takes it from there.
   */
  function startPolling(ch: BluetoothRemoteGATTCharacteristic): void {
    const mine = ++pollGen;
    polling = true;
    const loop = async (): Promise<void> => {
      while (mine === pollGen) {
        const began = now();
        try {
          const dv = await ch.readValue();
          if (mine !== pollGen) return;
          handleValue(dv);
        } catch (e) {
          if (mine !== pollGen) return;
          setStatus({ ...st, message: `Reading the sensor failed: ${errMessage(e)}` });
          return;
        }
        const wait = Math.max(0, POLL_MS - (now() - began));
        if (wait > 0) await new Promise<void>((resolve) => timers.setTimeout(resolve, wait));
      }
    };
    void loop();
  }

  function teardown(): void {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    retryTimer = undefined;
    detachCharacteristic(true);
    const d = device;
    d?.removeEventListener("gattserverdisconnected", onGattDisconnected);
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch {
      // already gone
    }
    rate.reset();
  }

  function scheduleReconnect(): void {
    if (retryTimer !== undefined) return;
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    attempt++;
    const name = deviceName();
    setStatus({
      connection: "connecting",
      ...(name ? { device: name } : {}),
      message:
        attempt === 1
          ? "The sensor disconnected. Reconnecting…"
          : `The sensor is still away. Reconnect attempt ${attempt} in ${Math.round(delay / 1000) || 1} s…`,
    });
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      if (!wanted) return;
      void start(++generation, true);
    }, delay);
  }

  function resolveUuids(): { service: BluetoothServiceUUID; characteristic: BluetoothServiceUUID } {
    if (!config.service?.trim() || !config.characteristic?.trim()) throw new Failure(MSG_NO_CONFIG);
    const service = normalizeUuid(config.service);
    if (service === undefined) throw new Failure(msgBadUuid("service", config.service));
    const ch = normalizeUuid(config.characteristic);
    if (ch === undefined) throw new Failure(msgBadUuid("characteristic", config.characteristic));
    return { service, characteristic: ch };
  }

  async function chooseDevice(bt: Bluetooth, service: BluetoothServiceUUID, gen: number): Promise<BluetoothDevice | undefined> {
    if (device && !mustPick) return device;
    if (!mustPick && typeof bt.getDevices === "function") {
      try {
        const known = pickKnownDevice(await bt.getDevices(), readStored(storage), config.namePrefix);
        if (known) return known;
      } catch {
        // fall through to the picker
      }
      if (gen !== generation) return undefined;
    }
    try {
      const d = await bt.requestDevice(requestOptions(config, service));
      mustPick = false;
      return d;
    } catch (e) {
      throw new Failure(pickErrorMessage(e));
    }
  }

  /** GATT connect + subscribe on `dev`; throws Failure */
  async function open(dev: BluetoothDevice, uuids: ReturnType<typeof resolveUuids>, gen: number): Promise<boolean> {
    const name = dev.name || undefined;
    const gatt = dev.gatt;
    if (!gatt) throw new Failure("This Bluetooth device has no GATT server, so it can't be the distance sensor.");
    const svcLabel = label(uuids.service);
    const chLabel = label(uuids.characteristic);
    let server;
    try {
      server = await gatt.connect();
    } catch (e) {
      throw new Failure(`Couldn't connect to the sensor${name ? ` “${name}”` : ""}: ${errMessage(e)}. Is it on and in range?`, true);
    }
    if (gen !== generation) return false;
    let svc;
    try {
      svc = await server.getPrimaryService(uuids.service);
    } catch (e) {
      const n = errName(e);
      if (n === "SecurityError") {
        mustPick = true;
        writeStored(storage, undefined);
        throw new Failure(MSG_PICK_AGAIN);
      }
      if (n === "NotFoundError") throw new Failure(msgServiceNotFound(svcLabel, name));
      if (n === "TypeError" || e instanceof TypeError) throw new Failure(msgBadUuid("service", config.service));
      throw new Failure(`Couldn't read the sensor's services: ${errMessage(e)}`, true);
    }
    if (gen !== generation) return false;
    let ch: BluetoothRemoteGATTCharacteristic;
    try {
      ch = await svc.getCharacteristic(uuids.characteristic);
    } catch (e) {
      const n = errName(e);
      if (n === "NotFoundError") throw new Failure(msgCharacteristicNotFound(chLabel, svcLabel));
      if (n === "TypeError" || e instanceof TypeError) throw new Failure(msgBadUuid("characteristic", config.characteristic));
      if (n === "SecurityError") throw new Failure(`The browser blocks characteristic ${chLabel} (it is on the Web Bluetooth blocklist).`);
      throw new Failure(`Couldn't read the sensor's characteristics: ${errMessage(e)}`, true);
    }
    if (gen !== generation) return false;
    const canNotify = ch.properties.notify || ch.properties.indicate;
    if (!canNotify && !ch.properties.read) throw new Failure(msgNoNotify(chLabel));
    characteristic = ch;
    if (canNotify) {
      ch.addEventListener("characteristicvaluechanged", onValue);
      try {
        await ch.startNotifications();
      } catch (e) {
        detachCharacteristic(false);
        if (!ch.properties.read) throw new Failure(`The sensor refused to start notifications: ${errMessage(e)}`, true);
        // notifications refused but the value is readable: poll it instead
        characteristic = ch;
        startPolling(ch);
      }
    } else {
      // read-only characteristic (some sensors never notify): poll it
      startPolling(ch);
    }
    if (gen !== generation) {
      detachCharacteristic(true);
      return false;
    }
    return true;
  }

  async function start(gen: number, reconnecting: boolean): Promise<void> {
    try {
      const uuids = resolveUuids();
      const bt = opts.bluetooth ?? navigatorBluetooth();
      if (!bluetoothAvailable(bt)) {
        const secure = opts.secureContext ?? (globalThis as { isSecureContext?: boolean }).isSecureContext;
        throw new Failure(secure === false ? MSG_INSECURE : MSG_NO_BLUETOOTH);
      }
      if (!reconnecting) setStatus({ connection: "connecting", message: "Looking for the sensor…" });
      const dev = await chooseDevice(bt!, uuids.service, gen);
      if (gen !== generation || !dev) return;
      if (dev !== device) {
        device?.removeEventListener("gattserverdisconnected", onGattDisconnected);
        device = dev;
        dev.addEventListener("gattserverdisconnected", onGattDisconnected);
      }
      writeStored(storage, dev.id);
      if (!reconnecting) {
        setStatus({ connection: "connecting", ...(dev.name ? { device: dev.name } : {}), message: "Connecting to the sensor…" });
      }
      const ok = await open(dev, uuids, gen);
      if (!ok || gen !== generation) return;
      attempt = 0;
      badValues = 0;
      setStatus({ connection: "connected", ...(dev.name ? { device: dev.name } : {}) });
    } catch (e) {
      if (gen !== generation) return;
      const failure = e instanceof Failure ? e : new Failure(`The sensor failed: ${errMessage(e)}`, true);
      detachCharacteristic(false);
      if (failure.retry && wanted && device && reconnecting) {
        // still away: keep trying while wanted
        scheduleReconnect();
        return;
      }
      // a configuration problem or a refusal: stop until the user acts
      wanted = false;
      fail(failure.message);
      if (device?.gatt?.connected) {
        try {
          device.gatt.disconnect();
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    connect() {
      if (st.connection === "connected" && characteristic) return Promise.resolve();
      if (pending) return pending;
      wanted = true;
      // a reconnect is waiting: try right away
      if (retryTimer !== undefined) {
        timers.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      const gen = ++generation;
      // never rejects: failures end up in status()
      pending = start(gen, false)
        .catch((e: unknown) => {
          if (gen === generation) fail(`The sensor failed: ${errMessage(e)}`);
        })
        .finally(() => {
          if (gen === generation) pending = undefined;
        });
      return pending;
    },
    disconnect() {
      wanted = false;
      generation++;
      pending = undefined;
      attempt = 0;
      const was = st.connection;
      teardown();
      if (was !== "disconnected") setStatus({ connection: "disconnected", ...(deviceName() ? { device: deviceName()! } : {}) });
    },
    status,
    onSample: (cb) => samples.add(cb),
    onStatus: (cb) => statuses.add(cb),
  };
}

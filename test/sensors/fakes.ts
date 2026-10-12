// Fake Web Bluetooth objects (no real radio) for the sensor tests.
import type {
  Bluetooth,
  BluetoothCharacteristicProperties,
  BluetoothDevice,
  BluetoothRemoteGATTCharacteristic,
  BluetoothRemoteGATTServer,
  BluetoothRemoteGATTService,
  BluetoothServiceUUID,
  RequestDeviceOptions,
} from "../../src/sensors/bluetooth.d.ts";
import { canonicalUuid, normalizeUuid } from "../../src/sensors/value.ts";

export class FakeTarget {
  listeners = new Map<string, Set<(e: Event) => void>>();
  addEventListener(type: string, cb: (e: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: Event) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  dispatch(type: string): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb({ type } as Event);
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export function domError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

const key = (u: BluetoothServiceUUID): string => canonicalUuid(normalizeUuid(u) ?? u);

export function props(p: Partial<BluetoothCharacteristicProperties> = {}): BluetoothCharacteristicProperties {
  return {
    broadcast: false,
    read: false,
    writeWithoutResponse: false,
    write: false,
    notify: false,
    indicate: false,
    ...p,
  };
}

export class FakeCharacteristic extends FakeTarget implements BluetoothRemoteGATTCharacteristic {
  value: DataView | null = null;
  notifying = false;
  readResult: DataView | Error = new DataView(new Uint8Array([0]).buffer);
  startError: Error | undefined;
  /** called by startNotifications, e.g. to push values */
  onStart: (() => void) | undefined;
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties;
  constructor(uuid: string, properties: BluetoothCharacteristicProperties) {
    super();
    this.uuid = key(uuid);
    this.properties = properties;
  }
  async readValue(): Promise<DataView> {
    if (this.readResult instanceof Error) throw this.readResult;
    this.value = this.readResult;
    return this.readResult;
  }
  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    if (this.startError) throw this.startError;
    this.notifying = true;
    this.onStart?.();
    return this;
  }
  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    this.notifying = false;
    return this;
  }
  /** a notification carrying these bytes */
  notify(bytes: number[] | Uint8Array): void {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.value = new DataView(u.buffer, u.byteOffset, u.byteLength);
    this.dispatch("characteristicvaluechanged");
  }
}

export class FakeService implements BluetoothRemoteGATTService {
  readonly uuid: string;
  chars: FakeCharacteristic[];
  constructor(uuid: string, chars: FakeCharacteristic[]) {
    this.uuid = key(uuid);
    this.chars = chars;
  }
  async getCharacteristic(c: BluetoothServiceUUID): Promise<FakeCharacteristic> {
    const hit = this.chars.find((x) => x.uuid === key(c));
    if (!hit) throw domError("NotFoundError", "No Characteristics matching UUID found in Service.");
    return hit;
  }
  async getCharacteristics(): Promise<FakeCharacteristic[]> {
    if (this.chars.length === 0) throw domError("NotFoundError", "No Characteristics found in service.");
    return this.chars;
  }
}

export class FakeServer implements BluetoothRemoteGATTServer {
  connected = false;
  connects = 0;
  connectError: Error | undefined;
  /** services the origin may access (optionalServices); undefined = all */
  allowed: Set<string> | undefined;
  readonly dev: FakeDevice;
  services: FakeService[];
  constructor(dev: FakeDevice, services: FakeService[]) {
    this.dev = dev;
    this.services = services;
  }
  async connect(): Promise<BluetoothRemoteGATTServer> {
    this.connects++;
    if (this.connectError) throw this.connectError;
    this.connected = true;
    return this;
  }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dev.dispatch("gattserverdisconnected");
  }
  async getPrimaryService(s: BluetoothServiceUUID): Promise<FakeService> {
    if (!this.connected) throw domError("NetworkError", "GATT Server is disconnected.");
    const k = key(s);
    if (this.allowed && !this.allowed.has(k)) throw domError("SecurityError", "Origin is not allowed to access the service.");
    const hit = this.services.find((x) => x.uuid === k);
    if (!hit) throw domError("NotFoundError", "No Services matching UUID found in Device.");
    return hit;
  }
  async getPrimaryServices(): Promise<FakeService[]> {
    if (!this.connected) throw domError("NetworkError", "GATT Server is disconnected.");
    const list = this.services.filter((x) => !this.allowed || this.allowed.has(x.uuid));
    if (list.length === 0) throw domError("NotFoundError", "No Services found in device.");
    return list;
  }
  /** the radio link drops (out of range, switched off) */
  drop(): void {
    if (!this.connected) return;
    this.connected = false;
    this.dev.dispatch("gattserverdisconnected");
  }
}

export class FakeDevice extends FakeTarget implements BluetoothDevice {
  readonly id: string;
  readonly name: string | null;
  readonly gatt: FakeServer;
  constructor(id: string, name: string | null, services: FakeService[]) {
    super();
    this.id = id;
    this.name = name;
    this.gatt = new FakeServer(this, services);
  }
}

export class FakeBluetooth implements Bluetooth {
  granted: FakeDevice[] = [];
  requestResult: FakeDevice | Error;
  requests: RequestDeviceOptions[] = [];
  getDevices?: () => Promise<BluetoothDevice[]>;
  constructor(result: FakeDevice | Error, withGetDevices = true) {
    this.requestResult = result;
    if (withGetDevices) this.getDevices = async () => this.granted;
  }
  async requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice> {
    this.requests.push(options);
    if (this.requestResult instanceof Error) throw this.requestResult;
    const d = this.requestResult;
    // the grant covers exactly the services named in this request
    d.gatt.allowed = new Set((options.optionalServices ?? []).map(key));
    if (!this.granted.includes(d)) this.granted.push(d);
    return d;
  }
}

export class MemStorage {
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

/** lets pending promise callbacks run */
export async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

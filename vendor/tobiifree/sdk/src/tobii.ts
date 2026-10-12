// tobii.ts — top-level entry point.
//
// `Tobii.fromUsb()` — direct USB (browser or Node), returns UsbSource.
// `Tobii.fromDaemon()` — WebSocket to tobiifreed, returns WsSource.

import { UsbSource, type UsbSourceOptions } from './usb_source';
import { WsSource } from './ws_source';
import { WebUsbTransport, TOBII_USB_FILTERS } from './webusb';
import { wasmBytes } from './wasm-bundle';
import type { Source } from './source';

export type UsbOptions = {
  /** Pre-selected USBDevice. If omitted, auto-picks (browser prompt or node scan). */
  device?: USBDevice;
  requestTimeoutMs?: number;
};

export type DaemonOptions = {
  /** WebSocket URL, e.g. "ws://localhost:7081". */
  url: string;
  requestTimeoutMs?: number;
};

async function pickDevice(): Promise<USBDevice> {
  // skilltree: browser only (the node `usb` path was removed from the vendored copy)
  if (typeof navigator !== 'undefined' && 'usb' in navigator) {
    const known = (await navigator.usb.getDevices()).find((d) =>
      TOBII_USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    return known ?? navigator.usb.requestDevice({ filters: TOBII_USB_FILTERS });
  }
  throw new Error('WebUSB is not available in this browser');
}

export const Tobii = {
  /** Direct USB connection (browser WebUSB or Node usb package). */
  async fromUsb(opts: UsbOptions = {}): Promise<UsbSource> {
    const device = opts.device ?? await pickDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    return UsbSource.create({
      transport,
      wasmBytes: wasmBytes(),
      requestTimeoutMs: opts.requestTimeoutMs,
    });
  },

  /** Connect to tobiifreed daemon via WebSocket. */
  async fromDaemon(opts: DaemonOptions): Promise<WsSource> {
    return WsSource.connect(opts.url, opts.requestTimeoutMs);
  },

  /** @deprecated Use `Tobii.fromUsb()` instead. */
  async createSession(opts: UsbOptions = {}): Promise<Source> {
    return Tobii.fromUsb(opts);
  },
};

// Loads a prebuilt library from the plugin's assets with a classic <script>
// tag and resolves the global it defines. The perception libraries (MediaPipe
// ~150 KB, vosk-browser ~5.6 MB with its inlined worker + wasm) are never
// bundled into skilltree.js: esbuild's iife output can't code-split, so a
// dynamic import() would inline them into the main bundle. Instead
// tools/fetch_models.sh copies their own browser builds next to the models.
// Same origin, so stash's CSP (script-src 'self') allows them.

import { PerceptionError } from "./errors.ts";

/** What we use of document (injectable for tests). */
export interface ScriptHost {
  createElement(tag: "script"): {
    src: string;
    async: boolean;
    addEventListener(type: "load" | "error", fn: () => void): void;
  };
  head: { appendChild(el: unknown): unknown };
}

const pending = new Map<string, Promise<unknown>>();

/**
 * Injects `<script src=url>` once and resolves `globalThis[globalName]`.
 * Concurrent and repeated calls share one load; a failed load can be retried.
 */
export function loadScriptGlobal<T>(
  url: string,
  globalName: string,
  host: ScriptHost = document as unknown as ScriptHost,
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): Promise<T> {
  const existing = scope[globalName];
  if (existing !== undefined) return Promise.resolve(existing as T);
  const key = `${url}#${globalName}`;
  let p = pending.get(key);
  if (!p) {
    p = new Promise<unknown>((resolve, reject) => {
      const el = host.createElement("script");
      el.async = true;
      el.addEventListener("load", () => {
        const g = scope[globalName];
        if (g === undefined) reject(new PerceptionError("assets-missing", `${url} loaded but did not define ${globalName}`));
        else resolve(g);
      });
      el.addEventListener("error", () =>
        reject(
          new PerceptionError(
            "assets-missing",
            `Could not load ${url}. Run tools/fetch_models.sh and make sure plugin/skilltree.yml maps ui.assets.`,
          ),
        ),
      );
      el.src = url;
      host.head.appendChild(el);
    });
    pending.set(key, p);
    p.catch(() => pending.delete(key));
  }
  return p as Promise<T>;
}

/** Forget cached loads (tests). */
export function resetScriptCache(): void {
  pending.clear();
}

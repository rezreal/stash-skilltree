// Per-viewer conveniences kept in localStorage. Every access is guarded:
// private windows and blocked storage simply mean nothing is remembered.

const PERFORMER_KEY = "skilltree.play.performer";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | undefined {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    return undefined;
  }
}

export function loadCurrentPerformer(store: StorageLike | undefined = storage()): string | undefined {
  try {
    const v = store?.getItem(PERFORMER_KEY);
    return v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function saveCurrentPerformer(id: string | undefined, store: StorageLike | undefined = storage()): void {
  try {
    if (id) store?.setItem(PERFORMER_KEY, id);
    else store?.removeItem(PERFORMER_KEY);
  } catch {
    // not remembered; the choice still holds for this page view
  }
}

# Vendored: tobiifree SDK

TypeScript SDK (with its WebAssembly protocol core embedded) from
https://github.com/Aetherall/tobiifree, commit `ad82906`, GPL-3.0 (see
LICENSE; compatible with this project's AGPL-3.0).

Changes for skilltree, all marked `skilltree:`:

- `sdk/src/webusb.ts`: accept the Tobii 4C (`2104:0127`) and IS5
  (`2104:031e`) besides the ET5. They use the same protocol (upstream PRs
  #12 and #13).
- `sdk/src/tobii.ts`: browser-only device picking; reuses an already
  permitted device before prompting.
- Removed the Node-only `nodeusb.ts` and `gusb.ts`.

Update by copying `sdk/src` from a newer upstream commit and reapplying
these changes.

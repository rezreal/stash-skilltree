#!/usr/bin/env bash
# Fills plugin/assets/ with everything the perception features load at runtime
# (served by stash through the manifest's `ui.assets` mapping `/: assets`,
# never from a CDN):
#
#   mediapipe/vision_bundle.js     MediaPipe tasks-vision IIFE build    (node_modules)
#   mediapipe/wasm/*               SIMD + no-SIMD wasm and loaders     (node_modules)
#   mediapipe/models/*.task        face / hand / pose landmarker models (storage.googleapis.com)
#   vosk/vosk.js                   vosk-browser UMD build              (node_modules)
#   vosk/speech-worklet.js         mic AudioWorklet                    (src/perception)
#   vosk/vosk-model-small-en-us-0.15.tar.gz
#                                  alphacephei's zip repackaged as the .tar.gz
#                                  vosk-browser loads (one top-level dir)
#
# Idempotent: files already present with the right checksum are kept.
# Downloads are verified against the MD5s their hosts publish (Google Cloud
# Storage x-goog-hash, alphacephei model-list.json), pinned below.
#
# Usage: tools/fetch_models.sh [--out DIR] [--force]
#   --out DIR   target directory (default: plugin/assets next to this repo)
#   --force     re-download / re-copy everything
#
# Needs: curl, unzip, tar, gzip, md5sum (or macOS md5), npm install done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/plugin/assets"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

MP_PKG="$ROOT/node_modules/@mediapipe/tasks-vision"
VOSK_PKG="$ROOT/node_modules/vosk-browser"
for d in "$MP_PKG" "$VOSK_PKG"; do
  [ -d "$d" ] || { echo "missing $d - run npm install first" >&2; exit 1; }
done
for tool in curl unzip tar gzip; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 1; }
done

md5_of() {
  if command -v md5sum >/dev/null; then md5sum "$1" | cut -d' ' -f1; else md5 -q "$1"; fi
}

pkg_version() {
  sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$1/package.json" | head -1
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/skilltree-assets.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT/mediapipe/wasm" "$OUT/mediapipe/models" "$OUT/vosk"

# copy SRC DEST: copies when missing or different
copy() {
  local src="$1" dest="$2"
  if [ "$FORCE" = 0 ] && [ -f "$dest" ] && cmp -s "$src" "$dest"; then
    echo "  ok      ${dest#"$OUT"/}"
  else
    cp "$src" "$dest.part" && mv "$dest.part" "$dest"
    echo "  copied  ${dest#"$OUT"/}"
  fi
}

# fetch URL DEST MD5: downloads when missing or the checksum differs
fetch() {
  local url="$1" dest="$2" md5="$3"
  if [ "$FORCE" = 0 ] && [ -f "$dest" ] && [ "$(md5_of "$dest")" = "$md5" ]; then
    echo "  ok      ${dest#"$OUT"/}"
    return
  fi
  echo "  fetch   $url"
  curl -fL --retry 3 --progress-bar -o "$TMP/dl" "$url"
  local got
  got="$(md5_of "$TMP/dl")"
  if [ "$got" != "$md5" ]; then
    echo "checksum mismatch for $url: md5 $got, expected $md5" >&2
    exit 1
  fi
  mv "$TMP/dl" "$dest"
  echo "  saved   ${dest#"$OUT"/} (md5 verified)"
}

echo "MediaPipe tasks-vision $(pkg_version "$MP_PKG") -> $OUT/mediapipe"
copy "$MP_PKG/vision_bundle.js" "$OUT/mediapipe/vision_bundle.js"
# the ES-module variant (vision_wasm_module_internal.*) is not used: we load the classic loader
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  copy "$MP_PKG/wasm/$f" "$OUT/mediapipe/wasm/$f"
done

GCS="https://storage.googleapis.com/mediapipe-models"
# face_landmarker.task bundles the detector, mesh (478 points with irises) and blendshapes models
fetch "$GCS/face_landmarker/face_landmarker/float16/1/face_landmarker.task" \
  "$OUT/mediapipe/models/face_landmarker.task" b0e7274907a1644404fef66b28dd6d85
fetch "$GCS/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task" \
  "$OUT/mediapipe/models/hand_landmarker.task" 15318430ea3851670fe9914116a9cfad
# lite: the viewer's webcam (one person, close); full: the person in the video
fetch "$GCS/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task" \
  "$OUT/mediapipe/models/pose_landmarker_lite.task" 04a75ddf7c811ac7a1a4523266dd7d88
fetch "$GCS/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task" \
  "$OUT/mediapipe/models/pose_landmarker_full.task" 83879689d373d143be094c972355e48e

echo "vosk-browser $(pkg_version "$VOSK_PKG") -> $OUT/vosk"
copy "$VOSK_PKG/dist/vosk.js" "$OUT/vosk/vosk.js"
copy "$ROOT/src/perception/speech-worklet.js" "$OUT/vosk/speech-worklet.js"

VOSK_NAME="vosk-model-small-en-us-0.15"
VOSK_TGZ="$OUT/vosk/$VOSK_NAME.tar.gz"
VOSK_ZIP_MD5="09ab50ccd62b674cbaa231b825f9c1cb"
# vosk-browser extracts with the first path component stripped, so the
# archive needs exactly one top-level directory holding am/ conf/ graph/ ivector/
vosk_ok() {
  [ -f "$VOSK_TGZ" ] && tar -tzf "$VOSK_TGZ" 2>/dev/null | grep -x "$VOSK_NAME/am/final.mdl" >/dev/null
}
if [ "$FORCE" = 0 ] && vosk_ok; then
  echo "  ok      vosk/$VOSK_NAME.tar.gz"
else
  echo "  fetch   https://alphacephei.com/vosk/models/$VOSK_NAME.zip"
  curl -fL --retry 3 --progress-bar -o "$TMP/model.zip" "https://alphacephei.com/vosk/models/$VOSK_NAME.zip"
  got="$(md5_of "$TMP/model.zip")"
  [ "$got" = "$VOSK_ZIP_MD5" ] || { echo "checksum mismatch for $VOSK_NAME.zip: md5 $got, expected $VOSK_ZIP_MD5" >&2; exit 1; }
  mkdir -p "$TMP/x"
  unzip -q "$TMP/model.zip" -d "$TMP/x"
  [ -f "$TMP/x/$VOSK_NAME/am/final.mdl" ] || { echo "unexpected layout in $VOSK_NAME.zip" >&2; exit 1; }
  [ -f "$TMP/x/$VOSK_NAME/conf/model.conf" ] || { echo "$VOSK_NAME.zip has no conf/model.conf" >&2; exit 1; }
  # reproducible archive where GNU tar allows it
  if tar --version 2>/dev/null | grep -q 'GNU tar'; then
    tar -C "$TMP/x" --sort=name --owner=0 --group=0 --numeric-owner --mtime='2020-12-08 00:00Z' \
      -cf "$TMP/model.tar" "$VOSK_NAME"
  else
    tar -C "$TMP/x" -cf "$TMP/model.tar" "$VOSK_NAME"
  fi
  gzip -n -9 -c "$TMP/model.tar" > "$VOSK_TGZ.part"
  mv "$VOSK_TGZ.part" "$VOSK_TGZ"
  vosk_ok || { echo "repackaged archive failed the layout check" >&2; exit 1; }
  echo "  saved   vosk/$VOSK_NAME.tar.gz (zip md5 verified, repackaged)"
fi

cat > "$OUT/VERSIONS.txt" <<EOF
@mediapipe/tasks-vision $(pkg_version "$MP_PKG")
vosk-browser $(pkg_version "$VOSK_PKG")
mediapipe models: face_landmarker float16/1, hand_landmarker float16/1, pose_landmarker_lite float16/1, pose_landmarker_full float16/1
vosk model: $VOSK_NAME
EOF

echo
echo "Totals:"
du -sh "$OUT/mediapipe/wasm" "$OUT/mediapipe/models" "$OUT/mediapipe/vision_bundle.js" "$OUT/vosk" | sed "s|$OUT/|  |"
du -sh "$OUT" | sed "s|$OUT|  total ($OUT)|"

# Skilltree — plan

A UI-only stash plugin that turns the library into a skill tree: a graph of
topics and levels you work through by actually watching, following and
performing what the clips ask. Progress is earned through checks (eye
tracking, voice, webcam, a distance sensor following funscripts), not by
pressing play.

Mockup: https://claude.ai/artifact/3w16htoe4NSEi9kctwkWAE (private)

## Principles

- **Everything in the browser.** No backend process. Sensors via WebUSB
  (Tobii 4C through the FreeTobi protocol), Web Bluetooth (distance sensor),
  getUserMedia (mic, webcam). ML models (MediaPipe, local speech-to-text) are
  served from the plugin's own `assets`, never a CDN.
- **All configuration lives in stash custom fields** with flat `st.*` keys.
  Custom field values must be scalars (string, number, bool), so lists are
  comma-separated strings.
- **Progress lives on scenes and tags**, so balance, depth and streaks are
  derived from data, never stored twice.
- **A viewing session is a transaction.** Nothing is written until a clip is
  completed. Abort (Esc, auto-abort, tab close, crash) means it didn't happen.
- **Coins are strictly virtual.** No way to buy or export them.
- Works behind a reverse proxy with a path prefix: every request is built from
  stash's `<base href>`.

## Data model

### Tags (`st.kind` decides the role)

| Key | Example | Meaning |
|---|---|---|
| `st.kind` | `interest` | `interest`, `trigger`, `policy`, `prompt`, `auto-marker` |
| `st.topic` | `fixation` | topic id (interest) |
| `st.level` | `2` | depth inside the topic, 0 = entry (interest) |
| `st.need` | `3` | completed scenes needed to complete this level (default 2, capped at the level's scene count) |
| `st.requires` | `relaxation:1,deepening:2\|fixation:2\|$80` | extra requirements, see below |
| `st.trigger` / `st.trigger_role` | `x` / `installed` | trigger pairs: installed → used is a hard edge within a performer |
| `st.policy` | `attention,prompts` | watch policy rules for tagged scenes |
| `st.min_minutes`, `st.track_min`, `st.hold_tol`, `st.hold_min_ms`, `st.idle_max`, `st.reward_mult` | | rule thresholds |
| `st.check` / `st.target` / `st.action` | `gaze` / `eyes` | prompt marker tags (see tools/extract_markers.py) |
| `st.paid`, `st.unlocked_at` | | written by the plugin when a priced node is bought |

### Requirement grammar (`st.requires`)

`,` = AND (binds loosest), `|` = OR, no parentheses (every monotone rule can
be written as an AND of OR-groups).

- `topic:level` — that level of that topic is **complete**
- `$n` — pay n coins. As its own group it is a **price**; behind `|` it is a
  **buyout** of the other alternatives

Every level L > 0 implicitly requires `topic:L-1`.

### Scenes (written by the plugin)

`st.completed_at`, `st.completions`, `st.earned`, `st.spent`,
`st.exposure_seconds`, `st.markers_extracted_at`, `st.markers_model`.

### Markers

Prompt markers: primary tag carries `st.kind=prompt` and `st.check`
(`repeat`, `gaze`, `action`, `spend`, plus `st.target`/`st.action`). The
marker window (`seconds`..`end_seconds`) is when compliance is checked.
`repeat`: title = phrase. `spend`: title = amount.

## Semantics

- **Node** = one (topic, level), formed by the interest tag(s) carrying it.
  A scene belongs to every node whose interest tag it has; with several levels
  of one topic, only the deepest counts.
- **Node state**: `locked` (requirements unmet) → `open` → `complete`
  (completed scenes ≥ need).
- **Levels are global**: they measure the user, not a performer. Performer
  chronology (scene date) only orders suggestions; trigger installed → used is
  hard.
- **Fog of war**: visible = complete ∪ open ∪ *ahead*. Ahead = locked nodes
  that would open if every currently open node completed. OR alternatives
  stay hidden until their own nodes are visible. *Gate* = a node whose only
  unmet groups can be paid now.
- **Layout**: radial, topics as spokes, ring = graph depth: `depth(n) = 1 +
  max over groups (min over alternatives of depth(alt))`; entry nodes without
  requirements sit at ring 0. Positions come from the full graph so fog
  clearing never moves nodes. A node with requirements from several topics
  sits at the mean angle of its parents.
- **Lint** (author view): unreachable nodes (reachability fixpoint, costs
  treated as payable) = error; cycles only through one alternative = warning;
  unknown topic/level refs; level gaps; nodes without scenes; need > scene
  count; trigger used but never installed; malformed `st.*` values.

## Watching

Watch policy = rules composed per scene from its tags:

- `attention` — gaze inside the video (with margin) for ≥ 90% of duration,
  attended intervals tracked (seeking is harmless). Grace → pause → abort.
- `exposure` — loops: audible playback time, adds up across sessions, may run
  in a background tab. Stopping a loop saves its minutes.
- `prompts` — markers: repeat-after-me (local STT, fuzzy match), webcam
  actions (MediaPipe), gaze targets on the person in the video (MediaPipe
  pose/face/hand on the video frames mapped to screen coordinates), spend
  prompts (hold-to-confirm or voice; declining fails the clip). Gaze prompts
  suspend the attention rule.
- `track` — funscript + BLE distance sensor. Sections: stroke (range +
  turning-point timing), hold (time inside band; flat with depth), ramp
  (sample-wise with lag compensation), idle (flat near 0, not scored, used
  for drift correction). Lag measured per session. User limits (max depth,
  max hold) stop scoring beyond them. Attention relaxes during track sections.

## Economy

- Earn per counted clip: `duration-based base × quality × st.reward_mult ×
  repeat decay (×0.5 per repeat) × streak bonus`, optional daily cap.
- Spend: `$n` requirements (price/buyout), spend prompts inside clips, toll
  levels (levels whose clips all ask to spend; paid once, passable for good).
- Clips you can't afford are never suggested. When blocked, an *Earn*
  suggestion (high-effort interactive clip) takes the slot.
- Streaks reward (more lookahead, bonus multiplier); optional reversible
  "rust" per topic, off by default. No progress loss.

## Daily series

Stash groups keep their scenes in order (`scene_index`) and carry custom
fields, so a series is configured on its group:

- `st.series = daily`: parts are watched in order, at most one per day.
- `st.reset = start` (default) or `step_back`: what happens when a day is
  missed after the series was started.
- The position is derived, never stored: the current run is the longest
  prefix of parts 1, 2, 3 ... completed on consecutive days, ending today or
  yesterday. Rewatching part 1 after a miss overwrites its date, which breaks
  the old chain, so the run restarts naturally.
- A plugin setting sets when the day ends (e.g. 04:00) so late sessions
  count for the right day.
- The choice screen shows an active series as its own card (part, run
  length, time left today); later parts are not suggested early.
- Falling back only moves the series position. Levels and coins earned stay.

## Flow

Start: pick a performer → each step suggests 1–2 scenes (continue / explore /
earn) from open nodes, plus a switch-performer row ranked by topic overlap →
player with live checks → completion summary (coins, nodes out of the fog).

## Repo layout

```
plugin/skilltree.yml      plugin manifest (ui.javascript, assets, csp, settings)
plugin/skilltree.js       built bundle (generated, not committed)
src/core/                 pure TypeScript: graph, requirements, progress, fog, layout, lint
src/stash/                GraphQL client + loading/mapping stash data into core input
src/ui/                   React (from PluginApi), routes, views
src/index.tsx             plugin entry
tools/extract_markers.py  local-LLM marker extraction from captions
test/                     node --test (TypeScript via Node's type stripping), python tests
build.mjs, build.sh       esbuild bundle; dist/ = zip + index.yml (plugin source)
```

Conventions: TypeScript with erasable syntax only (no enums, namespaces,
parameter properties) so Node can run tests directly; imports use explicit
`.ts` extensions; React, ReactDOM, react-router and react-bootstrap come from
`window.PluginApi` and are never bundled. Commits are authored as
`Anonymous <anonymous@example.com>` with prose messages explaining why.

## Phases

1. **Graph core + author view** — requirement parser, graph builder,
   progress/fog/layout, lint; stash data loading; plugin route with the author
   view (radial tree with author/fog toggle, lint list, per-level tables).
   Marker extraction tool. ← current
2. **Player + attention** — player route with own `<video>`, session
   transaction, attended intervals, fallback attention (focus/mouse),
   completion write-back, choice screen with suggestions, coins.
3. **Eye tracker** — FreeTobi protocol over WebUSB, calibration, gaze stream.
4. **Prompts** — markers, local STT, MediaPipe (webcam actions, gaze targets
   on the video person), spend prompts.
5. **Track** — Web Bluetooth distance sensor, calibration, section scoring,
   on-video guide.
6. **Economy + polish** — prices, tolls, streaks, fog reveal animations,
   plugin source publishing.

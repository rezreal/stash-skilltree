# Skilltree — plan

A UI-only stash plugin that turns the library into a skill tree: a graph of
topics and levels you work through by actually watching, following and
performing what the clips ask. Progress is earned through checks (eye
tracking, voice, webcam, a distance sensor following funscripts), not by
pressing play.

Mockup: https://claude.ai/artifact/3w16htoe4NSEi9kctwkWAE (private)

## Principles

- **Everything in the browser.** No backend process. Sensors via WebUSB
  (Tobii 4C through the tobiifree protocol), Web Bluetooth (distance sensor),
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

### Performers (written by the plugin)

`st.gaze_regions`: where the viewer looked on the clip's person, summed over
saved sessions — JSON `{"v":1,"sessions":n,"sec":{"eyes":12.3,...}}`.

### Markers

Prompt markers: primary tag carries `st.kind=prompt` and `st.check`
(`repeat`, `gaze`, `action`, `spend`, `mail`, plus `st.target`/`st.action`). The
marker window (`seconds`..`end_seconds`) is when compliance is checked.
`repeat`: title = phrase; the window stays open 3 s past an explicit end
(the marker covers the clip saying it, the viewer answers after).
`spend`: title = amount.
`mail`: title = the draft's body, optionally led by `To: … |` and
`Subject: … |` (a literal `\n` is a line break). The draft opens over the clip
at the start and plays along; the end is the latest time to send it, so from
there the clip waits until Send. Sending passes the prompt; nothing is sent.

## Semantics

- **Node** = one (topic, level), formed by the interest tag(s) carrying it.
  A scene belongs to every node whose interest tag it has; with several levels
  of one topic, only the deepest counts.
- **Node state**: `locked` (requirements unmet) → `open` → `complete`
  (completed scenes ≥ need).
- **Levels are global**: they measure the user, not a performer. Performer
  chronology and trigger installed → used are both hard.
- **Performer chronology** (hard, `src/play/chronology.ts`): a performer's
  clips are watched in date order across *all* their clips the plugin knows
  (tree scenes and series parts, not per topic). A clip may be offered only
  if, for each of its performers, every other clip of that performer with a
  strictly earlier date is completed — so a clip with several performers
  waits until it is next in line for every one of them. Same-date clips don't
  order each other. Undated clips are outside the chronology: they neither
  block nor are blocked (lint reports them). Completed clips stay allowed
  (repeats to earn were watched in their turn). It applies wherever a clip
  can be offered, ANDed with triggers and the daily-series rule: continue /
  explore / earn, performer switches and the start screen (a performer is
  listed only with a clip in line in an open node), and series cards (a
  series part waits like any clip; since parts count, a daily part that is
  next in line holds the performer's later clips until it is watched). When
  the performer's best continue clip is held back, the suggestion result
  says which performer it waits for, their next clips in line, and whether
  all of those are in locked levels (stalled until other levels open).
- **Fog of war**: visible = complete ∪ open ∪ *ahead*. Ahead = locked nodes
  that would open if every currently open node completed. OR alternatives
  stay hidden until their own nodes are visible. *Gate* = a node whose only
  unmet groups can be paid now.
- **Fog view** (the player's tree; the author view shows everything): hidden
  nodes are not drawn and nothing points towards them; ahead nodes are
  anonymous "?" discs whose unlock condition is phrased with visible nodes
  ("Opens after 3 more scenes in Relaxation L1"); gates show their price, and
  their topic only once the player has an open or complete node in it. Only
  such entered topics are ever named or labelled; header counts and the
  depth sidebar never reveal totals or levels beyond the reached one + 1.
  The view frames the drawn nodes only.
- **Layout**: organic, force-directed over the full graph (so fog clearing
  never moves nodes): a virtual START node fixed at the origin with entry
  nodes hanging off it, springs along requirement edges (previous level
  short and strong, explicit cross-topic edges long and weak, OR
  alternatives share one spring), repulsion between nodes, a weak pull
  towards each topic's centroid and a gentle radial bias by `depth(n) = 1 +
  max over groups (min over alternatives of depth(alt))`, so the tree grows
  away from START without levels sitting on rings. Initial positions come
  from a PRNG seeded by the node keys; fixed iteration count with cooling.
- **Lint** (author view): unreachable nodes (reachability fixpoint, costs
  treated as payable) = error; cycles only through one alternative = warning;
  unknown topic/level refs; level gaps; nodes without scenes; need > scene
  count; trigger used but never installed; malformed `st.*` values;
  chronology stall = warning (a performer's unwatched dated clip counts only
  for unreachable nodes, so their later clips can never come up).

## Watching

Watch policy = rules composed per scene from its tags:

- `attention` — gaze inside the video (with margin) for ≥ 90% of duration,
  attended intervals tracked (seeking is harmless). Grace → pause → abort.
- `exposure` — loops: audible playback time, adds up across sessions, may run
  in a background tab. Stopping a loop saves its minutes.
- `prompts` — markers: repeat-after-me (local STT, fuzzy match), webcam
  actions and body poses (MediaPipe: nod, shake, eyes closed/open, hand
  raised, still, arms up, hands on head, hands together, kneel, kneel
  sitting on the heels, stand, lie down; yoga: cat, cow, extended puppy,
  downward dog, plank, plow, straddle stretch, upward seated straddle, child's
  pose, standing forward fold, happy baby, savasana, upward salute, warrior II, tree, cobra; pose windows over 10 s are scored
  by the share of time in the pose), gaze targets on the person in the video (MediaPipe
  pose/face/hand on the video frames mapped to screen coordinates), spend
  prompts (hold-to-confirm or voice; declining fails the clip). A missed
  prompt up to 10 s long is replayed once (the clip seeks back to it);
  longer windows only count toward the prompts share at the end. A marker
  tag with `st.kind=replay`, `st.replay=yes|no` overrides this per marker.
  **Gaze prompts replace the attention target** while their window is
  active: attending = gaze inside the target region (`eyes_closed`: eyes
  closed — tracker present without gaze or webcam blink scores; an explicit
  "open" wins), so the usual grace → pause → resume → abort applies to the
  prompt ("Your eyes are open – close them to continue"; resumes as soon as
  the eyes close). No evidence (target not located, nothing tracked) counts
  as attending; presence still ANDs in. Overlapping gaze prompts: the one
  that started last leads; earlier ones count the overlap as no evidence.
  Scoring: windows ≤ 10 s (`LONG_WINDOW_SEC`) need a continuous hold of
  `holdSec`; longer (sustained) windows pass when ≥ 75 %
  (`SUSTAINED_MIN_SHARE`) of the evidence time was on target (and at least
  `holdSec` of it); time without evidence neither counts nor is required.
  The banner shows that share ("eyes closed 82% · need 75%").
  While an eyes_closed prompt runs the video dims a little (setting
  `eyesClosedDim`, default 30 %, capped at 60 % so the screen still lights
  the face for the webcam; 0.9 s fade in and out): the cue to close them and
  what a peek sees. The bar and the prompt banner stay bright.
  While a gaze prompt with a region on the video runs (every target but
  eyes_closed and off_screen), everything around the region blurs (setting
  `focusBlur`, default 60 % = sigma 12 px at full reach, 0 = off). A WebGL2
  canvas over the video redraws each frame through a fragment shader: the
  blur grows from 0 at the region's edge (its ellipse; a polygon by the
  ellipse through its bounding box's corners) to full 3.2 units out, the
  unit being the region's size capped at 100 px so large regions keep blur
  on screen; 16 Gaussian taps per pixel from the mip level matching their
  spacing. The blur builds up (smoothstep) over the first 8 s of the window
  and eases out at the end or when the region is lost for 1.5 s. It
  breathes every 6 s: up to 35 % softer while reaching 40 % further out,
  then strong and close again (none with prefers-reduced-motion). The canvas
  takes over the video's CSS filter (stash's Filters panel); a video stash
  rotates or scales is not blurred (src/player/focusBlur.ts,
  focusShader.ts, FocusBlur.tsx). A backdrop-filter version showed no blur
  over stash's player.
- `track` — funscript + BLE distance sensor. Depth = 100 − pos (funscript
  pos 100 = top of the stroke = out, 0 = deepest; files marked `inverted`
  are taken as is); the guide shows IN at the top. Sections: stroke (range +
  turning-point timing), hold (time inside band; flat with depth), ramp
  (sample-wise with lag compensation), idle (flat near 0, not scored, used
  for drift correction). Lag measured per session. User limits (max depth,
  max hold) stop scoring beyond them. Attention relaxes during track sections.
  Only scenes with a policy tag naming `track` get it (user decision: a
  funscript alone is not enough); without a connected, calibrated sensor it
  stays unscored. The sensor menu at /skilltree/sensor has four sections: Status
  (connection, auto-connect switch, live raw/position with a 10 s trace,
  readiness checklist), Calibrate (rest → deepest → check & save wizard),
  Range & limits (no-target raw range, max depth/hold, saved into the plugin
  settings) and Device ("Find my sensor"). Auto-connect (per browser, on by
  default): dropped links retry every ≤ 5 s, polled reads that fail or hang
  (2 s) three times in a row drop and re-open the link, a known sensor
  comes back when a track clip starts, and after a reload where the browser
  lists earlier grants (`getDevices`); otherwise the Watch/Test click of a
  track clip connects it (the click is the gesture the picker needs).
  Disconnect stops it until Connect. Match glow (`trackGlow`, default 70 %):
  the video's edges light strong green while the position is on the
  (lag-compensated) target, yellow turning red the further off (stroke
  15→45, hold 8→25, ramp 8→30 units), smoothed over 250 ms; only in scored
  sections with a live, calibrated sensor.
  Toy Sync (separate plugin, repo stash-toy-sync: Lovense vibrators and
  DG-LAB Coyote e-stim over Web Bluetooth, driven by the funscript):
  gating (`toyGate`, default on) sends `window` event `toysync:gain`
  {source: "skilltree", gain} = 1 − mismatch in 0.05 steps (1 when nothing
  is judged), null when the clip ends. Nudges (`nudgeTrack`, `nudgeGaze`,
  default on) send `toysync:nudge` {source, reason: "track" | "gaze"} after
  the condition held 1 s, then every 5 s while it lasts: track = mismatch ≥
  0.6 while playing; gaze = a gaze prompt reports "off" or the eye tracker
  sees the viewer look away (never on the fallback, never in a background
  window); none during a spend prompt or an open mail draft. Toy Sync
  rate-limits nudges (cooldown, per-minute cap) and only e-stim devices at
  their calibrated nudge level act on them.

- **Gaze regions** — with a real eye tracker (not the mouse stand-in) and
  video analysis on, MediaPipe pose + face run on the clip at ~2 Hz (the
  prompt checks' frames are reused around gaze prompts) and every gaze
  sample's time goes to the body region it lands on: eyes, mouth, hands,
  face, chest, groin, hips, torso, legs, feet (the most specific region
  wins), else rest of the body, elsewhere in the video, off the video.
  Counted only while the clip plays in front. The summary shows the
  session's shares; once the session is saved (complete, or a loop's
  minutes; ≥ 5 s counted) they are added to every performer of the clip
  (`st.gaze_regions`); the start screen's performer cards show the top
  three ("You looked at eyes 30%, face 22%, chest 12%", every region in
  the tooltip). Setting `gazeRegions` (default on).

- **Fullscreen** — a clip started with Watch (not an exposure loop) goes
  fullscreen when stash's player appears, using the click's user activation
  (kept across the in-app navigation, ~5 s in Chrome). Without it (reload,
  slow load, the sensor picker used it) the clip starts in the page. Setting
  `autoFullscreen` (default on).

- **Presence** — during a session the webcam runs continuously and the
  viewer must be in front of it (face or body found). Attention = present
  AND (gaze on the video, or the focus/activity stand-in without a
  tracker; during a gaze prompt: following the prompt). A setting makes the webcam required (default) — without camera
  permission a session cannot start. The camera is released when the
  session ends.

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
  count for the right day. `dayStartHour` (default 4) also applies to the
  streak and the daily earn cap.
- Part order: `scene_index` ascending; parts without an index come after
  those with one; ties by scene date (undated last), then scene id.
- States: *not-started* (part 1 never done: any day, no deadline), *due*
  (run ended yesterday: next part today, deadline = next day boundary),
  *done-today* (next part unlocks tomorrow), *broken* (last run day before
  yesterday), *finished* (all parts in one run; stays finished).
- `step_back`: every missed day (from the day after the last watch up to
  yesterday) steps the position back one part, never below 0; the next part
  is the one after it. Parts are then watched again, which overwrites their
  dates, so the position is derived from the most recent completion: part e
  on day D means position e at the end of D if some history of daily watches
  and misses explains the stored dates (walk backwards: part P's date = that
  day → watched; otherwise a miss from P+1, or, if P's date is later, an
  earlier watch overwritten by a rewatch). Today's position is
  `max(0, e − missed days)`. A completion no history explains (a part
  watched out of order) is skipped and its day counts as missed.
- The choice screen shows an active series as its own card (part, run
  length, time left today); later parts are not suggested early: series
  parts never appear as normal suggestions except the next part of a series
  that is not done for today.
- Falling back only moves the series position. Levels and coins earned stay.
- Malformed `st.series` / `st.reset` values and series without scenes are
  lint errors. The Setup view has a Series tab writing only these two keys.

## Flow

Start: pick a performer → each step suggests 1–2 scenes (continue / explore /
earn) from open nodes, plus a switch-performer row ranked by topic overlap →
player with live checks → completion summary (coins, nodes out of the fog).

## Deep links

The URL is each page's state: every click that changes the view pushes a
history entry and the page renders from the query string, so back, forward
and reload restore exactly what was open (typing in a search box replaces
the entry instead of adding one per keystroke):

- `/skilltree?node=Relaxation%3A2&performer=12` — tree, node selected, performer filter
- `/skilltree?fog=1&performer=12` — the viewer's fog view
- `/skilltree?view=setup&tag=345` — setup, tag 345 in the editor
- `/skilltree?view=setup&tab=ladder&topic=Relaxation` — topic ladder
- `/skilltree?view=setup&tab=series` — daily series setup
- `/skilltree/sensor?tab=status|calibrate|range|device` — sensor menu
- `/skilltree/play?performer=12` — play: that performer's suggestions
- `/skilltree/play?test=1&funscript=1&prompts=1&tags=4,9&q=intro&page=2` — test mode with its search

On the play page a link wins over the remembered performer / test mode and
becomes the remembered choice; a bare /skilltree/play (the nav entry)
resumes the remembered one.

A tag implies the tags tab, a topic the ladder tab; fog=1 wins over setup
(setup needs the author view); unknown nodes or performers are dropped.

## Test mode

A per-viewer switch in the choice screen header (localStorage) replaces the
suggestions with a test panel: search ANY stash scene (tags, all must match;
has funscript = `interactive`; has prompt markers = `markers_filter.tags` on
the `st.kind=prompt` tags; title contains), 25 per page, newest first.
"Test" opens the scene page with `?skilltree=test` (`test-loop` for exposure
loops: permitLoop is decided from the URL before the policy is loaded). A
scene outside the library is loaded on demand with the library's fields and
mapping, so its policy comes from its tags as usual. The session runs every
check (camera gate, presence, prompts, track, flashes, pause/speed locks)
but gets `persist: false`: it has no SessionWriter (`src/session/writes.ts`),
so nothing is committed or stored and nothing is paid; the summary previews
the would-be commit and the rule results ("Test mode – not saved"), the top
bar shows TEST. Stash's own player still records its play count / resume
time as for any play.

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
   view (skill tree with author/fog toggle, lint list, per-level tables).
   Marker extraction tool. ← current
2. **Player + attention** — player route with own `<video>`, session
   transaction, attended intervals, fallback attention (focus/mouse),
   completion write-back, choice screen with suggestions, coins.
3. **Eye tracker** — Tobii 4C / ET5 / IS5 over WebUSB through the vendored
   tobiifree SDK (vendor/tobiifree), device calibration plus an affine
   correction, attention from gaze; a mouse stand-in for development.
   WebXR (video in a headset, head gaze, eye gaze where exposed) is
   deferred.
   Then move playback onto stash's own ScenePlayer (patched, overlays inside
   the player container) so transcoding, Handy sync and markers keep working.
4. **Prompts** — markers, local STT, MediaPipe (webcam actions, gaze targets
   on the video person), spend prompts.
5. **Track** — Web Bluetooth distance sensor, calibration, section scoring,
   on-video guide.
6. **Economy + polish** — prices, tolls, streaks, fog reveal animations,
   plugin source publishing.

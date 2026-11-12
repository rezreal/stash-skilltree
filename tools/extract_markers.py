#!/usr/bin/env python3
"""Derive Skilltree prompt markers from scene captions using a local LLM.

Everything stays local: captions are read from your Stash server and sent only
to an OpenAI-compatible endpoint you run yourself (LM Studio by default).

Two steps, so you can review before anything is written:

  extract  scenes -> captions -> LLM -> validated candidates -> review JSONL
  apply    review JSONL -> tags (created if missing) -> scene markers

Examples:
  extract_markers.py extract --model qwen2.5-14b-instruct --limit 5 -o review.jsonl
  extract_markers.py extract --scene 123 --scene 456 -o review.jsonl
  extract_markers.py --stash https://stash.lan/stash --insecure extract --model ... --limit 3
  extract_markers.py apply review.jsonl
  extract_markers.py --stash https://stash.lan/stash --insecure --resolve stash.lan:192.168.1.10 extract ...

Delete lines (scenes) or entries in "markers" from the review file to skip them.
Only the standard library is used.
"""

import argparse
import datetime as dt
import difflib
import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.request

# --- taxonomy ----------------------------------------------------------------
# Must match what the plugin can verify.

GAZE_TARGETS = [
    "eyes", "face", "mouth", "hands", "chest", "torso", "hips", "groin", "legs",
    "feet_floor", "screen_center", "off_screen", "eyes_closed",
]
ACTIONS = ["nod", "shake_head", "eyes_closed", "eyes_open", "hand_raised", "still",
           "mouth_open", "mouth_closed", "hand_to_mouth", "stroking", "hands_off",
           "arms_up", "hands_on_head", "hands_together", "kneel",
           "kneel_sit", "stand", "lie_down",
           "cat", "cow", "puppy", "down_dog", "plank", "plow", "straddle",
           "straddle_up", "child", "forward_fold", "happy_baby", "savasana",
           "hastasana", "warrior", "tree", "cobra",
           "butterfly", "shoulder_stand"]
TYPES = ["repeat", "gaze", "action", "spend"]

# Seconds after the instruction ends during which the plugin checks compliance.
DEFAULT_WINDOWS = {"repeat": 6.0, "gaze": 5.0, "action": 5.0, "spend": 10.0}

AUTO_TAG = "Skilltree: auto-marker"

# --- prompt --------------------------------------------------------------------

SYSTEM_PROMPT = """You extract instructions from a video transcript.
The speaker talks to the viewer. Find ONLY clear, direct instructions that a
computer can verify, of these four types:

- repeat: the viewer is told to say specific words out loud ("repeat after me",
  "say ..."). "phrase" = the exact words the viewer must say, copied verbatim
  from the transcript.
- gaze: the viewer is told where to look. "target" is one of:
  eyes, face, mouth, hands, chest, torso, hips, groin, legs, feet_floor (floor in front
  of the speaker's feet), screen_center, off_screen (look away / down / close to
  nothing on screen), eyes_closed (the viewer is told to close their eyes in
  the middle of looking/gaze instructions, e.g. "look at my lips ... now close
  your eyes ... open them and look at my hands").
- action: the viewer is told to do a visible body action. "action" is one of:
  nod, shake_head, eyes_closed, eyes_open, hand_raised, still (stay completely
  still), mouth_open (open the mouth wide), mouth_closed (keep the mouth
  closed, e.g. holding something in it), hand_to_mouth (hold a hand up to the
  mouth), stroking (keep stroking / jerking), hands_off (stop stroking,
  hands off), arms_up, hands_on_head, hands_together, kneel, kneel_sit (kneel
  sitting back on the heels, as in meditation; also yoga thunderbolt pose /
  vajrasana), stand, lie_down, and the yoga
  poses cat, cow, puppy (extended puppy pose), down_dog (downward-facing dog),
  plank, plow, straddle (seated straddle stretch, legs wide on the floor),
  straddle_up (upward seated straddle, legs lifted wide), child (child's
  pose), forward_fold (standing forward fold), happy_baby, savasana (corpse
  pose), hastasana (upward salute: standing, arms straight overhead),
  warrior (warrior II: wide stance, front knee bent, arms out to the sides),
  tree (standing on one leg, the other foot on it), cobra (on the belly,
  chest lifted on the hands), butterfly (butterfly stretch / bound angle:
  seated, soles of the feet together, knees out to the sides), shoulder_stand
  (supported shoulder stand / sarvangasana: on the shoulders, legs straight
  up).
- spend: the viewer is told to send/give/pay an amount of money, coins or
  tribute. "amount" = the number as an integer.

Each request starts with the clip's title and description. Use them only as
hints about what the clip is about (for example that it involves eye contact,
repeating phrases or sending tribute). Never extract instructions from the
title or description themselves: only from the numbered transcript lines.

Rules:
- Skip anything vague or inner ("relax", "feel", "imagine", "let go", "sink").
- Skip hypotheticals, stories, questions and things the speaker says about
  themself.
- Skip instructions that do not fit the four types.
- cue_start = number of the line where the instruction starts, cue_end = line
  where it ends. Use the [numbers] shown.
- "Close your eyes" is ONE instruction: gaze with target eyes_closed when it
  is part of a run of gaze instructions, otherwise action eyes_closed. Never
  return both for the same line.
- When unsure, leave it out. An empty list is a good answer.
"""

FEW_SHOT_USER = """Title: Focus session
Description: A short session about eye contact and following simple instructions.

Transcript:
[1] (00:10.0) Good. Now take a deep breath.
[2] (00:13.5) Look into my eyes.
[3] (00:16.0) Keep looking. Don't look away.
[4] (00:21.0) Imagine you are floating.
[5] (00:25.2) Now repeat after me:
[6] (00:27.0) I listen and I follow.
[7] (00:31.0) Close your eyes now.
[8] (00:40.0) Send me fifty coins. Do it now."""

FEW_SHOT_ASSISTANT = json.dumps({"instructions": [
    {"type": "gaze", "cue_start": 2, "cue_end": 3, "phrase": "", "target": "eyes", "action": "", "amount": 0},
    {"type": "repeat", "cue_start": 5, "cue_end": 6, "phrase": "I listen and I follow", "target": "", "action": "", "amount": 0},
    {"type": "action", "cue_start": 7, "cue_end": 7, "phrase": "", "target": "", "action": "eyes_closed", "amount": 0},
    {"type": "spend", "cue_start": 8, "cue_end": 8, "phrase": "", "target": "", "action": "", "amount": 50},
]})

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "instructions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": TYPES},
                    "cue_start": {"type": "integer"},
                    "cue_end": {"type": "integer"},
                    "phrase": {"type": "string"},
                    "target": {"type": "string", "enum": GAZE_TARGETS + [""]},
                    "action": {"type": "string", "enum": ACTIONS + [""]},
                    "amount": {"type": "integer"},
                },
                "required": ["type", "cue_start", "cue_end", "phrase", "target", "action", "amount"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["instructions"],
    "additionalProperties": False,
}

# --- http ----------------------------------------------------------------------

SSL_CONTEXT = None  # set by --insecure for self-signed certificates


def http_json(url, payload=None, headers=None, timeout=60):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
        return json.loads(resp.read().decode())


def http_text(url, headers=None, timeout=60):
    req = urllib.request.Request(url)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:
        return resp.read().decode("utf-8", errors="replace")


class Stash:
    def __init__(self, url, api_key):
        self.url = url.rstrip("/")
        self.headers = {"ApiKey": api_key} if api_key else {}

    def gql(self, query, variables=None):
        res = http_json(self.url + "/graphql", {"query": query, "variables": variables or {}}, self.headers)
        if res.get("errors"):
            raise RuntimeError("GraphQL error: " + json.dumps(res["errors"]))
        return res["data"]

    def caption(self, scene_id, lang, ctype):
        url = "%s/scene/%s/caption?lang=%s&type=%s" % (self.url, scene_id, lang, ctype)
        return http_text(url, self.headers)


SCENE_FIELDS = """
  id title details
  files { duration }
  captions { language_code caption_type }
  custom_fields
"""


def iter_scenes(stash, scene_ids, limit):
    if scene_ids:
        for sid in scene_ids:
            data = stash.gql("query($id: ID!) { findScene(id: $id) { %s } }" % SCENE_FIELDS, {"id": sid})
            if data["findScene"]:
                yield data["findScene"]
        return
    page, seen = 1, 0
    while True:
        data = stash.gql(
            "query($f: FindFilterType, $s: SceneFilterType) { findScenes(filter: $f, scene_filter: $s) "
            "{ count scenes { %s } } }" % SCENE_FIELDS,
            {"f": {"page": page, "per_page": 100, "sort": "id", "direction": "ASC"},
             "s": {"captions": {"value": "", "modifier": "NOT_NULL"}}},
        )
        scenes = data["findScenes"]["scenes"]
        if not scenes:
            return
        for s in scenes:
            if not s.get("captions"):
                continue
            yield s
            seen += 1
            if limit and seen >= limit:
                return
        page += 1


# --- captions ------------------------------------------------------------------

TS_RE = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})")


def parse_ts(s):
    m = TS_RE.search(s)
    if not m:
        raise ValueError("bad timestamp: " + s)
    h, mnt, sec, ms = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + int(sec) + int(ms.ljust(3, "0")) / 1000


def parse_cues(text):
    """Parse WebVTT or SRT into [{'i', 'start', 'end', 'text'}]."""
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n")):
        lines = [l for l in block.strip().split("\n") if l.strip()]
        for idx, line in enumerate(lines):
            if "-->" in line:
                a, b = line.split("-->", 1)
                body = " ".join(lines[idx + 1:])
                body = re.sub(r"<[^>]+>", "", body).strip()
                if body:
                    cues.append({"i": len(cues) + 1, "start": parse_ts(a), "end": parse_ts(b), "text": body})
                break
    return cues


def chunk_cues(cues, size, overlap):
    if not cues:
        return
    step = max(1, size - overlap)
    for start in range(0, len(cues), step):
        yield cues[start:start + size]
        if start + size >= len(cues):
            return


def fmt_ts(sec):
    m, s = divmod(sec, 60)
    return "%02d:%04.1f" % (int(m), s)


def render_chunk(chunk, title="", details="", max_details=800):
    details = re.sub(r"\s+", " ", details or "").strip()
    if len(details) > max_details:
        details = details[:max_details].rsplit(" ", 1)[0] + " ..."
    lines = "\n".join("[%d] (%s) %s" % (c["i"], fmt_ts(c["start"]), c["text"]) for c in chunk)
    return "Title: %s\nDescription: %s\n\nTranscript:\n%s" % (title or "-", details or "-", lines)


# --- llm -----------------------------------------------------------------------


def ask_llm(base, model, chunk_text, use_schema, timeout):
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": FEW_SHOT_USER},
            {"role": "assistant", "content": FEW_SHOT_ASSISTANT},
            {"role": "user", "content": chunk_text},
        ],
    }
    if use_schema:
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "instructions", "strict": True, "schema": RESPONSE_SCHEMA},
        }
    res = http_json(base.rstrip("/") + "/chat/completions", payload, timeout=timeout)
    content = res["choices"][0]["message"]["content"]
    return parse_llm_json(content)


def parse_llm_json(content):
    content = re.sub(r"^```(?:json)?|```$", "", content.strip(), flags=re.M).strip()
    # drop reasoning blocks some local models emit
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    start = content.find("{")
    end = content.rfind("}")
    if start < 0 or end < 0:
        return []
    try:
        data = json.loads(content[start:end + 1])
    except json.JSONDecodeError:
        return []
    items = data.get("instructions", []) if isinstance(data, dict) else []
    return [x for x in items if isinstance(x, dict)]


# --- validation ----------------------------------------------------------------

NUM_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100,
}


def norm(s):
    return re.sub(r"[^a-z0-9' ]+", " ", s.lower()).split()


def numbers_in(text):
    found = {int(n) for n in re.findall(r"\d+", text.replace(",", ""))}
    words = norm(text)
    for i, w in enumerate(words):
        if w in NUM_WORDS:
            v = NUM_WORDS[w]
            nxt = words[i + 1] if i + 1 < len(words) else ""
            if nxt == "hundred":
                v *= 100
            elif v >= 20 and v < 100 and nxt in NUM_WORDS and NUM_WORDS[nxt] < 10:
                v += NUM_WORDS[nxt]
            found.add(v)
    return found


def phrase_in(phrase, text, threshold):
    p, t = norm(phrase), norm(text)
    if not p or len(p) > 25:
        return False
    n = len(p)
    best = 0.0
    for i in range(0, max(1, len(t) - n + 1)):
        window = t[i:i + n]
        best = max(best, difflib.SequenceMatcher(None, p, window).ratio())
        if best >= threshold:
            return True
    return best >= threshold


def validate(item, chunk, args):
    """Return (marker dict, None) or (None, reason)."""
    by_i = {c["i"]: c for c in chunk}
    kind = item.get("type")
    if kind not in TYPES or kind not in args.types:
        return None, "type"
    try:
        a, b = int(item.get("cue_start")), int(item.get("cue_end"))
    except (TypeError, ValueError):
        return None, "cue"
    if b < a:
        a, b = b, a
    if a not in by_i or b not in by_i or b - a > 6:
        return None, "cue"
    cues = [by_i[i] for i in range(a, b + 1) if i in by_i]
    # include one cue after for "repeat after me:" / phrase on the next line
    after = by_i.get(b + 1)
    text = " ".join(c["text"] for c in cues)
    text_plus = text + (" " + after["text"] if after else "")
    start, end = cues[0]["start"], cues[-1]["end"]
    window = args.window.get(kind, 5.0)
    marker = {
        "type": kind,
        "seconds": round(start, 2),
        "end_seconds": round(end + window, 2),
        "source": text,
    }
    if kind == "repeat":
        phrase = (item.get("phrase") or "").strip().strip("\"'")
        if len(norm(phrase)) < 2:
            return None, "phrase-short"
        if not phrase_in(phrase, text_plus, args.phrase_match):
            return None, "phrase-not-in-transcript"
        marker["title"] = phrase
        marker["tag"] = "Prompt: repeat"
        marker["tag_fields"] = {"st.kind": "prompt", "st.check": "repeat"}
    elif kind == "gaze":
        target = item.get("target")
        if target not in GAZE_TARGETS:
            return None, "target"
        marker["title"] = text[:120]
        marker["tag"] = "Prompt: gaze · " + target
        marker["tag_fields"] = {"st.kind": "prompt", "st.check": "gaze", "st.target": target}
    elif kind == "action":
        action = item.get("action")
        if action not in ACTIONS:
            return None, "action"
        marker["title"] = text[:120]
        marker["tag"] = "Prompt: action · " + action
        marker["tag_fields"] = {"st.kind": "prompt", "st.check": "action", "st.action": action}
    elif kind == "spend":
        try:
            amount = int(item.get("amount"))
        except (TypeError, ValueError):
            return None, "amount"
        if amount <= 0 or amount not in numbers_in(text_plus):
            return None, "amount-not-in-transcript"
        # amount lives in the title; the plugin reads it from there
        marker["title"] = str(amount)
        marker["tag"] = "Prompt: spend"
        marker["tag_fields"] = {"st.kind": "prompt", "st.check": "spend"}
    return marker, None


# A gaze eyes_closed and an action eyes_closed this close (seconds) are the
# same "close your eyes" instruction; the gaze variant is kept only when other
# gaze instructions are within EYES_CLOSED_CONTEXT_SEC of it.
EYES_CLOSED_CONTEXT_SEC = 60.0


def is_eyes_closed(m, kind=None):
    """kind: "gaze", "action" or None (either)."""
    fields = m.get("tag_fields") or {}
    if m.get("type") == "gaze" and kind in (None, "gaze"):
        return fields.get("st.target") == "eyes_closed"
    if m.get("type") == "action" and kind in (None, "action"):
        return fields.get("st.action") == "eyes_closed"
    return False


def resolve_eyes_closed(markers, gap=3.0, context=EYES_CLOSED_CONTEXT_SEC):
    """Keep one marker per "close your eyes": if the model returned both a gaze
    eyes_closed and an action eyes_closed within `gap` seconds, keep the gaze
    one when other gaze instructions (another target) are within `context`
    seconds (it belongs to a gaze sequence), else the action one."""
    drop = set()
    gazes = [m for m in markers if is_eyes_closed(m, "gaze")]
    actions = [m for m in markers if is_eyes_closed(m, "action")]
    for g in gazes:
        for a in actions:
            if id(g) in drop or id(a) in drop or abs(g["seconds"] - a["seconds"]) > gap:
                continue
            in_sequence = any(m["type"] == "gaze" and not is_eyes_closed(m)
                              and abs(m["seconds"] - g["seconds"]) <= context for m in markers)
            drop.add(id(a) if in_sequence else id(g))
    return [m for m in markers if id(m) not in drop]


def dedupe(markers, gap=3.0):
    out = []
    for m in sorted(resolve_eyes_closed(markers, gap), key=lambda m: m["seconds"]):
        dup = next((o for o in out if o["tag"] == m["tag"] and abs(o["seconds"] - m["seconds"]) <= gap
                    and (m["type"] != "repeat" or norm(o["title"]) == norm(m["title"]))), None)
        if dup is None:
            out.append(m)
    return out


# --- commands --------------------------------------------------------------------


def pick_caption(scene, lang):
    caps = scene.get("captions") or []
    if lang:
        caps = [c for c in caps if c["language_code"] == lang] or caps
    return caps[0] if caps else None


def cmd_extract(args):
    stash = Stash(args.stash, args.api_key)
    out = open(args.output, "a", encoding="utf-8")
    stats = {"scenes": 0, "kept": 0, "rejected": {}}
    try:
        for scene in iter_scenes(stash, args.scene, args.limit):
            cf = scene.get("custom_fields") or {}
            if cf.get("st.markers_extracted_at") and not args.force:
                log(args, "skip %s (already extracted)" % scene["id"])
                continue
            cap = pick_caption(scene, args.lang)
            if not cap:
                log(args, "skip %s (no captions)" % scene["id"])
                continue
            try:
                cues = parse_cues(stash.caption(scene["id"], cap["language_code"], cap["caption_type"]))
            except (urllib.error.URLError, ValueError) as e:
                log(args, "skip %s (caption error: %s)" % (scene["id"], e))
                continue
            markers = []
            chunks = list(chunk_cues(cues, args.chunk, args.overlap))
            for n, chunk in enumerate(chunks, 1):
                log(args, "scene %s: chunk %d/%d" % (scene["id"], n, len(chunks)))
                try:
                    prompt = render_chunk(chunk, scene.get("title"), "" if args.no_hints else scene.get("details"))
                    items = ask_llm(args.llm, args.model, prompt, not args.no_schema, args.timeout)
                except (urllib.error.URLError, KeyError, TimeoutError) as e:
                    log(args, "  llm error: %s" % e)
                    continue
                for item in items:
                    m, reason = validate(item, chunk, args)
                    if m:
                        markers.append(m)
                    else:
                        stats["rejected"][reason] = stats["rejected"].get(reason, 0) + 1
            markers = dedupe(markers)
            stats["scenes"] += 1
            stats["kept"] += len(markers)
            out.write(json.dumps({
                "scene_id": scene["id"],
                "title": scene.get("title") or "",
                "caption": "%s/%s" % (cap["language_code"], cap["caption_type"]),
                "model": args.model,
                "markers": markers,
            }, ensure_ascii=False) + "\n")
            out.flush()
            print("scene %s: %d candidate markers" % (scene["id"], len(markers)))
    finally:
        out.close()
    print("done: %d scenes, %d candidates, rejected by validation: %s"
          % (stats["scenes"], stats["kept"], json.dumps(stats["rejected"])))
    print("review %s, then run: %s apply %s" % (args.output, sys.argv[0], args.output))


def find_or_create_tag(stash, name, fields, cache, dry):
    if name in cache:
        return cache[name]
    data = stash.gql(
        "query($f: TagFilterType) { findTags(tag_filter: $f) { tags { id name } } }",
        {"f": {"name": {"value": name, "modifier": "EQUALS"}}},
    )
    tags = data["findTags"]["tags"]
    if tags:
        cache[name] = tags[0]["id"]
    elif dry:
        cache[name] = "(new)"
    else:
        data = stash.gql(
            "mutation($i: TagCreateInput!) { tagCreate(input: $i) { id } }",
            {"i": {"name": name, "custom_fields": fields}},
        )
        cache[name] = data["tagCreate"]["id"]
        print("created tag %r" % name)
    return cache[name]


def cmd_apply(args):
    stash = Stash(args.stash, args.api_key)
    cache = {}
    auto_tag = find_or_create_tag(stash, AUTO_TAG, {"st.kind": "auto-marker"}, cache, args.dry_run)
    total = 0
    with open(args.review, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            sid = entry["scene_id"]
            for m in entry.get("markers", []):
                tag_id = find_or_create_tag(stash, m["tag"], m.get("tag_fields", {}), cache, args.dry_run)
                if args.dry_run:
                    print("would create on scene %s: %s @ %.1f–%.1f %r"
                          % (sid, m["tag"], m["seconds"], m["end_seconds"], m["title"]))
                else:
                    stash.gql(
                        "mutation($i: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $i) { id } }",
                        {"i": {
                            "scene_id": sid, "title": m["title"], "seconds": m["seconds"],
                            "end_seconds": m["end_seconds"], "primary_tag_id": tag_id, "tag_ids": [auto_tag],
                        }},
                    )
                total += 1
            if not args.dry_run:
                stash.gql(
                    "mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id } }",
                    {"i": {"id": sid, "custom_fields": {"partial": {
                        "st.markers_extracted_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                        "st.markers_model": entry.get("model", ""),
                    }}}},
                )
    print("%s %d markers" % ("would create" if args.dry_run else "created", total))


def log(args, msg):
    if args.verbose:
        print(msg, file=sys.stderr)


def parse_windows(s):
    w = dict(DEFAULT_WINDOWS)
    for part in filter(None, (s or "").split(",")):
        k, v = part.split("=")
        w[k.strip()] = float(v)
    return w


def parse_resolve(items):
    """["stash.lan:192.168.1.10", ...] -> {"stash.lan": "192.168.1.10"} (like curl --resolve, port optional)"""
    out = {}
    for item in items or []:
        parts = item.split(":")
        if len(parts) == 3:  # curl style host:port:addr
            parts = [parts[0], parts[2]]
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise SystemExit("--resolve expects HOST:ADDRESS, e.g. stash.lan:192.168.1.10 (got %r)" % item)
        out[parts[0].lower()] = parts[1]
    return out


def install_resolve(mapping):
    """Answers DNS lookups for these host names with fixed addresses. The URL
    keeps the name, so TLS (SNI) and the Host header still say e.g. "stash.lan"."""
    if not mapping:
        return
    real = socket.getaddrinfo

    def getaddrinfo(host, *a, **kw):
        if isinstance(host, str) and host.lower() in mapping:
            host = mapping[host.lower()]
        return real(host, *a, **kw)

    socket.getaddrinfo = getaddrinfo


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--stash", default=os.environ.get("STASH_URL", "http://localhost:9999"))
    p.add_argument("--api-key", default=os.environ.get("STASH_API_KEY", ""))
    p.add_argument("--insecure", action="store_true", help="accept self-signed TLS certificates")
    p.add_argument("--resolve", action="append", metavar="HOST:ADDRESS",
                   help="use this address for a host name that doesn't resolve here, "
                        "e.g. stash.lan:192.168.1.10 (repeatable)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("extract", help="find candidate markers and write a review file")
    e.add_argument("--llm", default=os.environ.get("LLM_URL", "http://localhost:1234/v1"),
                   help="OpenAI-compatible base URL (LM Studio default)")
    e.add_argument("--model", required=True, help="model id as shown by LM Studio")
    e.add_argument("--scene", action="append", help="scene id (repeatable); default: all scenes with captions")
    e.add_argument("--limit", type=int, default=0, help="max scenes to process")
    e.add_argument("--lang", default="", help="preferred caption language code")
    e.add_argument("--types", default=",".join(TYPES), help="comma list of types to keep")
    e.add_argument("--chunk", type=int, default=40, help="cues per LLM request")
    e.add_argument("--overlap", type=int, default=6, help="cues shared between chunks")
    e.add_argument("--phrase-match", type=float, default=0.85, help="fuzzy match threshold for repeat phrases")
    e.add_argument("--window", default="", help="override check windows, e.g. repeat=8,spend=15")
    e.add_argument("--no-hints", action="store_true", help="don't send the scene description to the model")
    e.add_argument("--no-schema", action="store_true", help="don't send response_format (older servers)")
    e.add_argument("--timeout", type=int, default=600)
    e.add_argument("--force", action="store_true", help="also process scenes already extracted")
    e.add_argument("-o", "--output", default="markers_review.jsonl")

    a = sub.add_parser("apply", help="create markers from a reviewed file")
    a.add_argument("review")
    a.add_argument("--dry-run", action="store_true")

    args = p.parse_args()
    install_resolve(parse_resolve(args.resolve))
    if args.insecure:
        global SSL_CONTEXT
        SSL_CONTEXT = ssl._create_unverified_context()
    if args.cmd == "extract":
        args.types = [t.strip() for t in args.types.split(",") if t.strip()]
        args.window = parse_windows(args.window)
        cmd_extract(args)
    else:
        cmd_apply(args)


if __name__ == "__main__":
    main()

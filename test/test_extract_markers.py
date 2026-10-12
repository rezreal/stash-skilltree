"""Offline tests for tools/extract_markers.py (no Stash or LLM needed)."""
import json, sys, types
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import extract_markers as em

vtt = """WEBVTT

00:00:10.000 --> 00:00:13.000
Good. Now take a deep breath.

00:00:13.500 --> 00:00:16.000
Look into my eyes.

00:00:25.200 --> 00:00:27.000
Now repeat after me:

00:00:27.000 --> 00:00:30.500
<i>I obey and I listen.</i>

00:00:40.000 --> 00:00:44.000
Send me seventy five coins.

00:01:05.000 --> 00:01:08.000
Close your eyes.
"""
cues = em.parse_cues(vtt)
assert len(cues) == 6 and cues[3]["text"] == "I obey and I listen.", cues
assert abs(cues[4]["start"] - 40.0) < 1e-6
srt = "1\n00:00:01,500 --> 00:00:03,000\nHello there\n\n2\n00:00:04,000 --> 00:00:05,000\nSay hi\n"
assert [c["text"] for c in em.parse_cues(srt)] == ["Hello there", "Say hi"]

args = types.SimpleNamespace(types=em.TYPES, window=dict(em.DEFAULT_WINDOWS), phrase_match=0.85)
good = [
  {"type":"gaze","cue_start":2,"cue_end":2,"phrase":"","target":"eyes","action":"","amount":0},
  {"type":"repeat","cue_start":3,"cue_end":3,"phrase":"I obey and I listen","target":"","action":"","amount":0},
  {"type":"spend","cue_start":5,"cue_end":5,"phrase":"","target":"","action":"","amount":75},
  {"type":"action","cue_start":6,"cue_end":6,"phrase":"","target":"","action":"eyes_closed","amount":0},
]
bad = [
  {"type":"repeat","cue_start":3,"cue_end":3,"phrase":"something never said here","target":"","action":"","amount":0},
  {"type":"spend","cue_start":5,"cue_end":5,"phrase":"","target":"","action":"","amount":500},
  {"type":"gaze","cue_start":99,"cue_end":99,"phrase":"","target":"eyes","action":"","amount":0},
  {"type":"gaze","cue_start":2,"cue_end":2,"phrase":"","target":"elbow","action":"","amount":0},
]
ms = []
for it in good:
    m, r = em.validate(it, cues, args); assert m, (it, r); ms.append(m)
for it in bad:
    m, r = em.validate(it, cues, args); assert m is None, it
    assert r
assert ms[1]["title"] == "I obey and I listen" and ms[1]["end_seconds"] == round(27.0 + 6, 2)
assert ms[2]["title"] == "75"
assert len(em.dedupe(ms + [dict(ms[0])])) == 4
r = em.render_chunk(cues[:2], "T", "D " * 600)
assert r.startswith("Title: T\nDescription: D") and "Transcript:\n[1] (00:10.0)" in r and len(r) < 1100, r
assert em.parse_llm_json('<think>hmm</think>```json\n{"instructions":[{"type":"gaze"}]}\n```') == [{"type": "gaze"}]
assert list(map(len, em.chunk_cues(list(range(100)), 40, 6))) == [40, 40, 32]
print("OK")

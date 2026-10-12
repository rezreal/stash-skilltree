# Skilltree

> **Alpha, in development.** See [PLAN.md](PLAN.md) for the design and phases.

A **UI-only** [stash](https://github.com/stashapp/stash) plugin that turns the
library into a skill tree: topics and levels you unlock by actually watching,
following and performing what the clips ask. Configuration lives in tag
custom fields (`st.*`), progress on scenes.

## Development

```bash
npm install
npm run check      # typecheck, tests, bundle
./build.sh         # dist/: plugin zip + index.yml (a stash plugin source)
```

Manual install: copy `plugin/skilltree.yml`, `plugin/skilltree.js` and
`plugin/skilltree.css` into a `skilltree` folder in your stash `plugins`
directory, then Settings > Plugins > Reload Plugins.

## Deriving prompt markers from captions

`tools/extract_markers.py` reads each scene's captions from stash, asks a
**local** OpenAI-compatible model (LM Studio by default) for clear,
verifiable instructions, validates every candidate against the transcript,
and writes a review file. Nothing leaves your machine. Standard library only.

```bash
python3 tools/extract_markers.py --stash https://stash.lan/stash --insecure \
  extract --model <model id in LM Studio> --limit 3 -v
# review markers_review.jsonl, delete what you don't want, then:
python3 tools/extract_markers.py --stash https://stash.lan/stash --insecure \
  apply markers_review.jsonl --dry-run
```

Created markers carry the `Skilltree: auto-marker` tag for bulk review or
removal. Processed scenes get `st.markers_extracted_at` and are skipped on the
next run unless `--force` is given.

## License

AGPL-3.0, like stash.

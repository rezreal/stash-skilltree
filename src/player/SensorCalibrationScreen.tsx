// /skilltree/sensor: the distance sensor for track clips. Connect (a click:
// the Bluetooth picker needs a user gesture), watch the live reading,
// capture the rest and the deepest position (median of 1.5 s each), check
// the resulting 0..100 mapping by moving, and save it. "Find my sensor"
// lists what a Bluetooth device offers (discover.ts) and saves the chosen
// service / characteristic / format into the plugin settings through stash's
// configurePlugin mutation (or shows the values to type in when that isn't
// available). The user's limits are shown on top and on the meter.
import type { TrackCalibration, ValueFormat } from "../track/types.ts";
import { calibrate, toPosition } from "../track/index.ts";
import {
  choiceFrom,
  discoverCharacteristics,
  splitUuidList,
  type DiscoveredCharacteristic,
  type DiscoveredService,
  type DiscoveryResult,
} from "../sensors/discover.ts";
import { VALUE_FORMATS, isValueFormat } from "../sensors/value.ts";
import { PLUGIN_ID, pluginApi, usePluginSettings } from "../ui/pluginApi.ts";
import { router } from "./api.ts";
import { PLAY_ROUTE, errorText } from "./common.tsx";
import {
  CAPTURE_MS,
  captureFrom,
  captureProblem,
  limitsLine,
  mergePluginSettings,
  sensorRowView,
  settingsLines,
  type Capture,
  type SensorSettingsPatch,
} from "./trackView.ts";
import { useTicker, useTrackSensor, type TrackSensorHandle } from "./useTrack.ts";
import type { DistanceSample } from "../track/types.ts";

type ConfigurePlugin = (opts: { variables: { plugin_id: string; input: Record<string, unknown> } }) => Promise<unknown>;

/** stash's useConfigurePlugin (StashService), when this stash exposes it */
function useConfigurePlugin(): ConfigurePlugin | undefined {
  const svc = pluginApi().utils?.StashService as unknown as { useConfigurePlugin?: () => [ConfigurePlugin, ...unknown[]] } | undefined;
  // present or absent for the page's lifetime, so the hook order is stable
  const hook = svc?.useConfigurePlugin;
  const result = hook ? hook() : undefined;
  return result?.[0];
}

const fmt = (n: number | undefined, digits = 1) => (n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits));

export function SensorCalibrationScreen() {
  const { Link } = router();
  const sensor = useTrackSensor();
  const connected = sensor.status?.connection === "connected";
  useTicker(connected, 100); // live value and rate

  return (
    <div className="skilltree-play">
      <div className="stp-sensor-page">
        <div className="stp-calib-head">
          <h1 className="stp-h1">Distance sensor</h1>
          <Link to={PLAY_ROUTE} className="stp-small stp-orange">
            Back to choices
          </Link>
        </div>
        <p className="stp-soft stp-lh">
          Track clips follow the scene's funscript with a Bluetooth distance sensor. Set the sensor up once here: connect it,
          calibrate your rest and deepest positions, and check the mapping. The sensor is optional: without it track clips
          still play, the track part just isn't scored.
        </p>
        <div className="stp-limits-box stp-lh" role="note">
          <strong>{limitsLine(sensor.limits)}</strong>{" "}
          <span>Change them in Settings › Plugins › Skilltree. Stop a clip any time with Stop or Esc.</span>
        </div>
        {sensor.settings.problems.length > 0 && (
          <ul className="stp-small stp-orange">
            {sensor.settings.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <ConnectionPanel sensor={sensor} />
        {sensor.configured && <CalibrationPanel sensor={sensor} />}
        <DiscoveryPanel sensor={sensor} />
      </div>
    </div>
  );
}

function ConnectionPanel(props: { sensor: TrackSensorHandle }) {
  const { sensor } = props;
  const status = sensor.status;
  const view = sensorRowView(status, {
    configured: sensor.configured,
    calibrated: sensor.calibrated,
    ...(status?.rate !== undefined ? { rate: status.rate } : {}),
  });
  const connected = status?.connection === "connected";
  const sample = sensor.latest();
  return (
    <section className="stp-panel" aria-labelledby="stp-sensor-conn">
      <div className="stp-panel-head">
        <h2 id="stp-sensor-conn" className="stp-caps">
          Connection
        </h2>
        {sensor.settings.config && (
          <span className="stp-small stp-muted stp-mono">
            {sensor.settings.config.service} / {sensor.settings.config.characteristic} · {sensor.settings.config.format}
          </span>
        )}
      </div>
      {!sensor.bluetooth && (
        <p className="stp-small stp-orange stp-lh">
          This browser has no Web Bluetooth. Use Chrome or Edge (desktop or Android) and open stash over https or
          http://localhost.
        </p>
      )}
      <div className="stp-row">
        <span>{view.title}</span>
        <span className={`stp-tone-${view.tone}`}>{view.connection}</span>
      </div>
      {connected && (
        <div className="stp-row stp-small">
          <span className="stp-muted">Rate</span>
          <span className="stp-mono">{view.rate}</span>
        </div>
      )}
      {view.hint && <p className="stp-small stp-muted stp-lh">{view.hint}</p>}
      {!sensor.configured && (
        <p className="stp-small stp-lh">No sensor is configured yet. Use “Find my sensor” below to find and save it.</p>
      )}
      {connected && (
        <div className="stp-row">
          <span className="stp-muted">Raw reading</span>
          <span className="stp-sensor-value" aria-live="off">
            {fmt(sample?.raw)}
            {sample?.noTarget ? " · no target" : ""}
          </span>
        </div>
      )}
      {sensor.configured && (
        <div className="stp-sensor-actions">
          {view.canConnect ? (
            <button type="button" className="stp-btn stp-btn-orange" onClick={sensor.connect} disabled={!sensor.bluetooth}>
              Connect sensor
            </button>
          ) : (
            <button type="button" className="stp-btn stp-btn-outline" onClick={sensor.disconnect}>
              Disconnect
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** a vertical 0..100 meter (100 at the top) with the max-depth line */
function Meter(props: { position: number | undefined; maxDepth: number; label: string }) {
  const p = props.position;
  return (
    <div className="stp-sensor-meter" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p === undefined ? undefined : Math.round(p)}>
      <span className="stp-sensor-meter-label" style={{ top: 4 }}>
        100 in
      </span>
      <span className="stp-sensor-meter-label" style={{ bottom: 4 }}>
        0 rest
      </span>
      {p !== undefined && <div className="stp-sensor-meter-fill" style={{ height: `${Math.max(0, Math.min(100, p))}%` }} />}
      {props.maxDepth < 100 && (
        <div className="stp-sensor-meter-limit" style={{ top: `${100 - props.maxDepth}%` }} title={`Your max depth: ${props.maxDepth}`} />
      )}
    </div>
  );
}

type CaptureKind = "rest" | "deep";

function CalibrationPanel(props: { sensor: TrackSensorHandle }) {
  const { sensor } = props;
  const connected = sensor.status?.connection === "connected";
  const [rest, setRest] = React.useState<Capture | undefined>(undefined);
  const [deep, setDeep] = React.useState<Capture | undefined>(undefined);
  const [capturing, setCapturing] = React.useState<{ kind: CaptureKind; start: number } | undefined>(undefined);
  const [note, setNote] = React.useState<string | undefined>(undefined);
  useTicker(capturing !== undefined, 100);

  React.useEffect(() => {
    if (!capturing) return;
    const buffer: DistanceSample[] = [];
    const off = sensor.subscribe((s) => buffer.push(s));
    const timer = window.setTimeout(() => {
      off();
      const c = captureFrom(buffer, capturing.start, capturing.start + CAPTURE_MS);
      if (!c) setNote("Too few readings in 1.5 s. Check that the sensor is connected and sending, then capture again.");
      else if (capturing.kind === "rest") setRest(c);
      else setDeep(c);
      setCapturing(undefined);
    }, CAPTURE_MS + 50);
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [capturing]);

  const start = (kind: CaptureKind) => {
    setNote(undefined);
    setCapturing({ kind, start: performance.now() });
  };

  let candidate: TrackCalibration | undefined;
  let candidateError: string | undefined;
  if (rest && deep) {
    try {
      candidate = calibrate(rest.value, deep.value, new Date().toISOString());
    } catch (err) {
      candidateError = errorText(err);
    }
  }
  const problem = captureProblem(rest, deep) ?? candidateError;
  const mapping = candidate ?? sensor.calibration;
  const sample = sensor.latest();
  const position = sample && mapping ? (sample.noTarget ? 0 : toPosition(sample.raw, mapping)) : undefined;
  const progress = capturing ? Math.min(1, (performance.now() - capturing.start) / CAPTURE_MS) : 0;

  const save = () => {
    if (!candidate) return;
    const stored = sensor.setCalibration(candidate);
    setRest(undefined);
    setDeep(undefined);
    setNote(stored ? "Saved. Track clips use this mapping from now on." : "The browser blocked storage: the mapping applies until the page is reloaded.");
  };

  return (
    <section className="stp-panel" aria-labelledby="stp-sensor-cal">
      <div className="stp-panel-head">
        <h2 id="stp-sensor-cal" className="stp-caps">
          Calibration
        </h2>
        <span className="stp-small stp-muted">
          {sensor.calibration
            ? `saved: rest ${fmt(sensor.calibration.rawAtZero)} → deepest ${fmt(sensor.calibration.rawAtFull)}`
            : "not calibrated"}
        </span>
      </div>
      <div className="stp-sensor-live">
        <div className="stp-col stp-gap-sm">
          <div className="stp-sensor-steps">
            <div className="stp-sensor-step">
              <span className="stp-strong">1 · Rest position</span>
              <span className="stp-small stp-muted stp-lh">Relax at your resting point (position 0) and hold still.</span>
              <span className="stp-mono">{rest ? `${fmt(rest.value)} (${rest.samples} readings)` : "—"}</span>
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm stp-self-start" disabled={!connected || !!capturing} onClick={() => start("rest")}>
                {capturing?.kind === "rest" ? `Hold still… ${Math.round(progress * 100)}%` : "Capture rest"}
              </button>
            </div>
            <div className="stp-sensor-step">
              <span className="stp-strong">2 · Deepest position</span>
              <span className="stp-small stp-muted stp-lh">
                Only as deep as is comfortable (position 100).
                {sensor.limits.maxDepth < 100
                  ? ` Scoring stops at your max depth (${Math.round(sensor.limits.maxDepth)}) of this point.`
                  : " Nothing deeper than this point is ever asked for or scored."}
              </span>
              <span className="stp-mono">{deep ? `${fmt(deep.value)} (${deep.samples} readings)` : "—"}</span>
              <button type="button" className="stp-btn stp-btn-outline stp-btn-sm stp-self-start" disabled={!connected || !!capturing} onClick={() => start("deep")}>
                {capturing?.kind === "deep" ? `Hold still… ${Math.round(progress * 100)}%` : "Capture deepest"}
              </button>
            </div>
          </div>
          {!connected && <p className="stp-small stp-muted">Connect the sensor to calibrate.</p>}
          {problem && (
            <p className="stp-small stp-orange stp-lh" role="alert">
              {problem}
            </p>
          )}
          {note && (
            <p className="stp-small stp-soft stp-lh" role="status">
              {note}
            </p>
          )}
          <p className="stp-small stp-muted stp-lh">
            {candidate
              ? "3 · Move between rest and your deepest point: the meter should run from 0 to 100. Then save."
              : mapping
                ? "The meter shows the saved mapping. Capture both positions again to replace it."
                : "After both captures, move and watch the meter before saving."}
          </p>
          <div className="stp-row">
            <span className="stp-muted">Position</span>
            <span className="stp-sensor-value">{position === undefined ? "—" : Math.round(position)}</span>
          </div>
          <div className="stp-sensor-actions">
            <button type="button" className="stp-btn stp-btn-orange" disabled={!candidate || !!problem} onClick={save}>
              Save calibration
            </button>
            {sensor.calibration && (
              <button
                type="button"
                className="stp-btn stp-btn-outline"
                onClick={() => {
                  sensor.setCalibration(undefined);
                  setNote("The calibration is cleared. Track clips need a new one.");
                }}
              >
                Clear saved
              </button>
            )}
          </div>
        </div>
        <Meter position={position} maxDepth={sensor.limits.maxDepth} label="Calibrated position, 0 at rest, 100 deepest" />
      </div>
    </section>
  );
}

// --- Find my sensor --------------------------------------------------------------------

interface Choice {
  service: string;
  characteristic: string;
  format: ValueFormat;
  offset: number;
}

function DiscoveryPanel(props: { sensor: TrackSensorHandle }) {
  const { sensor } = props;
  const settings = usePluginSettings();
  const configurePlugin = useConfigurePlugin();
  const current = sensor.settings.config;
  const [extra, setExtra] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<string | undefined>(undefined);
  const [result, setResult] = React.useState<DiscoveryResult | undefined>(undefined);
  const [choice, setChoice] = React.useState<Choice>(() => ({
    service: current?.service ?? "",
    characteristic: current?.characteristic ?? "",
    format: current?.format ?? "uint16le",
    offset: current?.offset ?? 0,
  }));
  const [scale, setScale] = React.useState(String(current?.scale ?? 1));
  const [namePrefix, setNamePrefix] = React.useState(current?.namePrefix ?? "");
  const [saveState, setSaveState] = React.useState<{ kind: "saved" | "error" | "manual"; text?: string } | undefined>(undefined);

  const run = async () => {
    // one GATT connection per device at a time: free the sensor first
    sensor.disconnect();
    setRunning(true);
    setResult(undefined);
    setSaveState(undefined);
    const r = await discoverCharacteristics({ extraServices: splitUuidList(extra), onProgress: setProgress });
    setRunning(false);
    setProgress(undefined);
    setResult(r);
    if (r.device?.name && !namePrefix) setNamePrefix(r.device.name);
  };

  const pick = (svc: DiscoveredService, ch: DiscoveredCharacteristic, cand?: DiscoveredCharacteristic["candidates"][number]) => {
    setChoice(choiceFrom(svc, ch, cand));
    setSaveState(undefined);
  };

  const scaleNum = Number(scale.replace(",", "."));
  const patch: SensorSettingsPatch | undefined =
    choice.service.trim() && choice.characteristic.trim() && Number.isFinite(scaleNum) && scaleNum !== 0
      ? {
          sensorService: choice.service.trim(),
          sensorCharacteristic: choice.characteristic.trim(),
          sensorFormat: choice.format,
          sensorOffset: Math.max(0, Math.floor(choice.offset)),
          sensorScale: scaleNum,
          ...(namePrefix.trim() ? { sensorNamePrefix: namePrefix.trim() } : {}),
        }
      : undefined;

  const save = async () => {
    if (!patch) return;
    if (!configurePlugin) {
      setSaveState({ kind: "manual" });
      return;
    }
    try {
      await configurePlugin({ variables: { plugin_id: PLUGIN_ID, input: mergePluginSettings(settings, patch) } });
      setSaveState({ kind: "saved" });
    } catch (err) {
      setSaveState({ kind: "error", text: errorText(err) });
    }
  };

  return (
    <section className="stp-panel" aria-labelledby="stp-sensor-find">
      <div className="stp-panel-head">
        <h2 id="stp-sensor-find" className="stp-caps">
          Find my sensor
        </h2>
      </div>
      <p className="stp-small stp-soft stp-lh">
        Pick your sensor in the browser's list. The page then lists its services and characteristics and listens to each one
        that sends notifications for a few seconds: <strong>move the sensor while it samples</strong>, then pick the
        characteristic whose values change with the distance.
      </p>
      <p className="stp-small stp-muted stp-lh">
        Browsers only show services the page asks for by UUID. Common ones are asked for automatically; if your sensor shows
        nothing useful, enter its service UUID (from its documentation, or a phone app such as nRF Connect) and search again.
      </p>
      <label className="stp-field">
        Extra service UUIDs (optional, separated by spaces or commas)
        <input value={extra} onChange={(e) => setExtra(e.currentTarget.value)} placeholder="0xfff0, 6e400001-b5a3-f393-e0a9-e50e24dcca9e" />
      </label>
      <div className="stp-sensor-actions">
        <button type="button" className="stp-btn stp-btn-orange" disabled={running || !sensor.bluetooth} onClick={() => void run()}>
          {running ? "Searching…" : "Find my sensor"}
        </button>
      </div>
      {progress && (
        <p className="stp-small stp-soft" role="status">
          {progress}
        </p>
      )}
      {result && <DiscoveryList result={result} choice={choice} onPick={pick} />}

      <div className="stp-disc-service">
        <span className="stp-strong">Sensor settings</span>
        <div className="stp-form-grid">
          <label className="stp-field">
            Service UUID
            <input value={choice.service} onChange={(e) => setChoice({ ...choice, service: e.currentTarget.value })} />
          </label>
          <label className="stp-field">
            Characteristic UUID
            <input value={choice.characteristic} onChange={(e) => setChoice({ ...choice, characteristic: e.currentTarget.value })} />
          </label>
          <label className="stp-field">
            Format
            <select
              value={choice.format}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (isValueFormat(v)) setChoice({ ...choice, format: v });
              }}
            >
              {VALUE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="stp-field">
            Offset (bytes)
            <input
              type="number"
              min={0}
              step={1}
              value={choice.offset}
              onChange={(e) => setChoice({ ...choice, offset: Math.max(0, Number(e.currentTarget.value) || 0) })}
            />
          </label>
          <label className="stp-field">
            Scale
            <input value={scale} inputMode="decimal" onChange={(e) => setScale(e.currentTarget.value)} />
          </label>
          <label className="stp-field">
            Name filter (optional)
            <input value={namePrefix} onChange={(e) => setNamePrefix(e.currentTarget.value)} />
          </label>
        </div>
        <div className="stp-sensor-actions">
          <button type="button" className="stp-btn stp-btn-orange" disabled={!patch} onClick={() => void save()}>
            Save to plugin settings
          </button>
        </div>
        {saveState?.kind === "saved" && (
          <p className="stp-small stp-blue" role="status">
            Saved. Connect the sensor above and calibrate it.
          </p>
        )}
        {saveState?.kind === "error" && (
          <p className="stp-small stp-error" role="alert">
            Couldn't save the settings: {saveState.text}. Enter them in Settings › Plugins › Skilltree instead:
          </p>
        )}
        {saveState?.kind === "manual" && (
          <p className="stp-small stp-soft" role="status">
            This stash can't save plugin settings from here. Enter these in Settings › Plugins › Skilltree:
          </p>
        )}
        {patch && (saveState?.kind === "manual" || saveState?.kind === "error") && (
          <dl className="stp-kv">
            {settingsLines(patch).map(([k, v]) => (
              <React.Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

function DiscoveryList(props: {
  result: DiscoveryResult;
  choice: Choice;
  onPick: (svc: DiscoveredService, ch: DiscoveredCharacteristic, cand?: DiscoveredCharacteristic["candidates"][number]) => void;
}) {
  const { result, choice } = props;
  return (
    <div className="stp-col stp-gap-sm">
      {result.device && (
        <span className="stp-small">
          Device: <span className="stp-mono">{result.device.name ?? result.device.id}</span>
        </span>
      )}
      {result.invalid.length > 0 && <p className="stp-small stp-orange">Not valid UUIDs (skipped): {result.invalid.join(", ")}</p>}
      {result.error && (
        <p className="stp-small stp-orange stp-lh" role="alert">
          {result.error}
        </p>
      )}
      {result.services.map((svc) => (
        <div key={svc.uuid} className="stp-disc-service">
          <span className="stp-small">
            <span className="stp-strong">Service </span>
            <span className="stp-mono">{svc.short}</span>
            {svc.name ? <span className="stp-muted"> · {svc.name}</span> : null}
          </span>
          {svc.error && <p className="stp-small stp-orange">{svc.error}</p>}
          {svc.characteristics.map((ch) => {
            const chosen = choice.service === svc.short && choice.characteristic === ch.short;
            const flags = [ch.properties.notify && "notify", ch.properties.indicate && "indicate", ch.properties.read && "read", ch.properties.write && "write"]
              .filter(Boolean)
              .join(" · ");
            const streams = ch.properties.notify || ch.properties.indicate;
            return (
              <div key={ch.uuid} className={`stp-disc-char${chosen ? " is-chosen" : ""}`}>
                <div className="stp-row stp-small">
                  <span>
                    <span className="stp-mono">{ch.short}</span>
                    {ch.name ? <span className="stp-muted"> · {ch.name}</span> : null}
                  </span>
                  <span className="stp-muted">{flags}</span>
                </div>
                {ch.samples.length > 0 ? (
                  <div className="stp-disc-bytes stp-muted">
                    {ch.samples.slice(0, 4).map((s, i) => (
                      <div key={i}>
                        {s.hex} <span className="stp-soft">“{s.ascii}”</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="stp-small stp-muted">{streams ? "no notifications while sampling" : "no value"}</span>
                )}
                {ch.error && <span className="stp-small stp-orange">{ch.error}</span>}
                {streams && ch.candidates.length > 0 && (
                  <div className="stp-disc-cands" aria-label="Possible decodings">
                    {ch.candidates.map((c) => {
                      const on = chosen && choice.format === c.format && choice.offset === c.offset;
                      return (
                        <button
                          key={`${c.format}@${c.offset}`}
                          type="button"
                          className={`stp-disc-cand${on ? " is-chosen" : ""}`}
                          title={c.reason}
                          onClick={() => props.onPick(svc, ch, c)}
                        >
                          {c.format}
                          {c.offset ? ` @${c.offset}` : ""}: {c.values.map((v) => (v === undefined ? "?" : +v.toFixed(2))).join(", ")}
                        </button>
                      );
                    })}
                  </div>
                )}
                {streams && (
                  <button type="button" className="stp-btn stp-btn-outline stp-btn-sm stp-self-start" onClick={() => props.onPick(svc, ch)}>
                    {chosen ? "Chosen" : "Use this one"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

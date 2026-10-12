// /skilltree/sensor: the distance sensor for track clips (tagged with the
// track rule; they follow the scene's funscript),
// as a menu of four sections (?tab=…):
// - Status: connection with Connect / Disconnect, the auto-connect switch,
//   the live raw reading and calibrated position with a 10 s trace, and a
//   checklist of what track clips still need to be scored;
// - Calibrate: a three-step wizard - capture the rest and the deepest
//   position (median of 1.5 s each), check the 0..100 mapping by moving,
//   save it;
// - Range & limits: the raw range that means "no target" and the viewer's
//   max depth / max hold, saved into the plugin settings;
// - Device: "Find my sensor" lists what a Bluetooth device offers
//   (discover.ts) and saves the chosen service / characteristic / format.
// Settings are saved through stash's configurePlugin mutation, merged into
// the whole map (it replaces it), or shown to type in when that isn't
// available.
import type * as ReactTypes from "react";
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
  SENSOR_TABS,
  TRACE_H,
  TRACE_MS,
  TRACE_W,
  captureFrom,
  captureProblem,
  limitsLine,
  mergePluginSettings,
  mergeSettings,
  parseRangeForm,
  parseSensorTab,
  rangeFormFrom,
  rawVerdict,
  readinessView,
  sensorMenuView,
  sensorRowView,
  settingsLines,
  tracePolylines,
  validRangeText,
  type Capture,
  type RangeForm,
  type SensorSettingsPatch,
  type SensorTab,
} from "./trackView.ts";
import { SENSOR_ROUTE, useTicker, useTrackSensor, type TrackSensorHandle } from "./useTrack.ts";
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

function currentSearch(): string {
  try {
    return window.location.search;
  } catch {
    return "";
  }
}

export function SensorCalibrationScreen() {
  const { Link, useHistory } = router();
  const history = useHistory();
  const sensor = useTrackSensor();
  const connected = sensor.status?.connection === "connected";
  useTicker(connected, 100); // live value, trace and rate
  const [tab, setTabState] = React.useState<SensorTab>(() => parseSensorTab(currentSearch()));
  const setTab = React.useCallback(
    (t: SensorTab) => {
      setTabState(t);
      history.replace(t === "status" ? SENSOR_ROUTE : `${SENSOR_ROUTE}?tab=${t}`);
    },
    [history],
  );
  const items = sensorMenuView({
    configured: sensor.configured,
    status: sensor.status,
    calibration: sensor.calibration,
    config: sensor.settings.config,
    limits: sensor.limits,
  });
  const tabRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const onMenuKey = (e: ReactTypes.KeyboardEvent, i: number) => {
    const n = items.length;
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(items[next]!.id);
    tabRefs.current[next]?.focus();
  };

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
          Track clips (tagged with a policy whose rules include track) follow the scene's funscript with your Bluetooth
          distance sensor. The sensor is optional: without it the clips still play, the track just isn't scored.
        </p>
        {sensor.settings.problems.length > 0 && (
          <ul className="stp-small stp-orange">
            {sensor.settings.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="stp-sensor-layout">
          <nav className="stp-sensor-menu" aria-label="Sensor menu">
            <div role="tablist" aria-orientation="vertical" className="stp-sensor-menu-list">
              {items.map((item, i) => (
                <button
                  key={item.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`stp-sensor-tab-${item.id}`}
                  aria-selected={tab === item.id}
                  aria-controls={`stp-sensor-pane-${item.id}`}
                  tabIndex={tab === item.id ? 0 : -1}
                  className={`stp-sensor-menu-item${tab === item.id ? " is-active" : ""}`}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(e) => onMenuKey(e, i)}
                >
                  <span className="stp-sensor-menu-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="stp-sensor-menu-label">{SENSOR_TABS[i]!.label}</span>
                  <span className={`stp-sensor-menu-badge stp-tone-${item.tone}`}>{item.badge}</span>
                </button>
              ))}
            </div>
          </nav>
          <div className="stp-sensor-content" role="tabpanel" id={`stp-sensor-pane-${tab}`} aria-labelledby={`stp-sensor-tab-${tab}`}>
            {tab === "status" && <StatusTab sensor={sensor} onTab={setTab} />}
            {tab === "calibrate" && <CalibrateTab sensor={sensor} onTab={setTab} />}
            {tab === "range" && <RangeTab sensor={sensor} />}
            {tab === "device" && <DeviceTab sensor={sensor} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Status ---------------------------------------------------------------------------------

function StatusTab(props: { sensor: TrackSensorHandle; onTab: (t: SensorTab) => void }) {
  const { sensor } = props;
  const status = sensor.status;
  const connected = status?.connection === "connected";
  const view = sensorRowView(status, {
    configured: sensor.configured,
    calibrated: sensor.calibrated,
    ...(status?.rate !== undefined ? { rate: status.rate } : {}),
  });
  const readiness = readinessView({ configured: sensor.configured, connected, calibrated: sensor.calibrated });
  return (
    <>
      <section className="stp-panel" aria-labelledby="stp-sensor-conn">
        <div className="stp-panel-head">
          <h2 id="stp-sensor-conn" className="stp-caps">
            Connection
          </h2>
          <span className={`stp-small stp-tone-${view.tone}`}>{view.connection}</span>
        </div>
        {!sensor.bluetooth && (
          <p className="stp-small stp-orange stp-lh">
            This browser has no Web Bluetooth. Use Chrome or Edge (desktop or Android) and open stash over https or
            http://localhost.
          </p>
        )}
        {connected && (
          <div className="stp-row stp-small">
            <span className="stp-muted">Rate</span>
            <span className="stp-mono">{view.rate}</span>
          </div>
        )}
        {view.hint && <p className="stp-small stp-muted stp-lh">{view.hint}</p>}
        {!sensor.configured ? (
          <div className="stp-sensor-actions">
            <button type="button" className="stp-btn stp-btn-orange" onClick={() => props.onTab("device")}>
              Find my sensor
            </button>
          </div>
        ) : (
          <div className="stp-sensor-actions">
            {view.canConnect ? (
              <button type="button" className="stp-btn stp-btn-orange" onClick={sensor.connect} disabled={!sensor.bluetooth}>
                Connect sensor
              </button>
            ) : status?.connection === "connecting" ? (
              <>
                <button type="button" className="stp-btn stp-btn-orange" onClick={sensor.connect}>
                  Try now
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={sensor.disconnect}>
                  Stop trying
                </button>
              </>
            ) : (
              <button type="button" className="stp-btn stp-btn-outline" onClick={sensor.disconnect}>
                Disconnect
              </button>
            )}
          </div>
        )}
        {sensor.configured && (
          <div className="stp-col stp-gap-sm stp-sensor-auto">
            <label className="stp-toggle">
              <input type="checkbox" checked={sensor.autoConnect} onChange={(e) => sensor.setAutoConnect(e.currentTarget.checked)} />
              Connect automatically
            </label>
            <p className="stp-small stp-muted stp-lh">
              When the link drops (out of range, switched off) it is retried every few seconds. With this on, the sensor also
              comes back by itself when a track clip starts.{" "}
              {sensor.reloadReconnects
                ? "This browser remembers the sensor, so it reconnects after a page reload without a click too."
                : "After a page reload this browser needs one click: Watch on a track clip does it (the browser's sensor list opens once), or Connect here. Enable chrome://flags/#enable-web-bluetooth-new-permissions-backend to reconnect without any click."}
            </p>
          </div>
        )}
      </section>

      {sensor.configured && <LivePanel sensor={sensor} />}

      <section className="stp-panel" aria-labelledby="stp-sensor-ready">
        <div className="stp-panel-head">
          <h2 id="stp-sensor-ready" className="stp-caps">
            Track clips
          </h2>
        </div>
        <ol className="stp-sensor-checklist">
          {readiness.steps.map((step) => (
            <li key={step.label} className={step.done ? "is-done" : ""}>
              <span className="stp-sensor-check" aria-hidden="true">
                {step.done ? "✓" : ""}
              </span>
              <span>{step.label}</span>
              {!step.done && (
                <button type="button" className="stp-linkbtn stp-small stp-orange" onClick={() => props.onTab(step.tab)}>
                  {step.tab === "status" ? "Connect" : step.tab === "calibrate" ? "Calibrate" : "Set up"}
                </button>
              )}
            </li>
          ))}
        </ol>
        <p className={`stp-small stp-lh ${readiness.ready ? "stp-blue" : "stp-soft"}`}>{readiness.summary}</p>
        <p className="stp-small stp-muted stp-lh">{limitsLine(sensor.limits)}</p>
      </section>
    </>
  );
}

interface TracePoint {
  t: number;
  pos: number | undefined;
  raw: number | undefined;
}

/** the live reading: raw value, what it means, calibrated position, a meter and a 10 s trace */
function LivePanel(props: { sensor: TrackSensorHandle }) {
  const { sensor } = props;
  const connected = sensor.status?.connection === "connected";
  const buffer = React.useRef<TracePoint[]>([]);
  React.useEffect(
    () =>
      sensor.subscribe((s) => {
        const b = buffer.current;
        b.push({ t: s.t, pos: sensor.latestPosition(), raw: s.noTarget ? undefined : s.raw });
        const cut = s.t - TRACE_MS - 500;
        while (b.length > 0 && b[0]!.t < cut) b.shift();
      }),
    [],
  );
  const sample = sensor.latest();
  const position = sensor.calibrated ? sensor.latestPosition() : undefined;
  const config = sensor.settings.config;

  const now = performance.now();
  const pts = buffer.current;
  let lines: string[];
  let traceLabel: string;
  if (sensor.calibrated) {
    lines = tracePolylines(pts, now);
    traceLabel = "Position over the last 10 seconds, 0 at rest, 100 deepest; gaps are lost readings";
  } else {
    // no calibration yet: raw readings scaled to what was seen
    const raws = pts.map((p) => p.raw).filter((r): r is number => r !== undefined);
    const lo = Math.min(...raws);
    const hi = Math.max(...raws);
    const span = hi - lo || 1;
    lines = tracePolylines(
      pts.map((p) => ({ t: p.t, pos: p.raw === undefined ? undefined : ((p.raw - lo) / span) * 100 })),
      now,
    );
    traceLabel = "Raw readings over the last 10 seconds, scaled to what was seen; gaps are lost readings";
  }

  return (
    <section className="stp-panel" aria-labelledby="stp-sensor-live">
      <div className="stp-panel-head">
        <h2 id="stp-sensor-live" className="stp-caps">
          Live
        </h2>
        <span className="stp-small stp-muted">no target: outside {validRangeText(config)}</span>
      </div>
      {!connected ? (
        <p className="stp-small stp-muted">Connect the sensor to see its readings.</p>
      ) : (
        <div className="stp-sensor-live">
          <div className="stp-col stp-gap-sm">
            <div className="stp-sensor-readouts">
              <div className="stp-col">
                <span className="stp-small stp-muted">Raw</span>
                <span className="stp-sensor-value" aria-live="off">
                  {fmt(sample?.raw)}
                </span>
                <span className={`stp-small ${sample?.noTarget ? "stp-orange" : "stp-muted"}`}>{rawVerdict(sample?.raw, config)}</span>
              </div>
              <div className="stp-col">
                <span className="stp-small stp-muted">Position</span>
                <span className="stp-sensor-value" aria-live="off">
                  {position === undefined ? "—" : Math.round(position)}
                </span>
                <span className="stp-small stp-muted">{sensor.calibrated ? "0 rest · 100 deepest" : "calibrate to see it"}</span>
              </div>
            </div>
            <svg className="stp-sensor-trace" viewBox={`0 0 ${TRACE_W} ${TRACE_H}`} preserveAspectRatio="none" role="img" aria-label={traceLabel}>
              <line className="stp-track-grid" x1="0" y1={TRACE_H / 2} x2={TRACE_W} y2={TRACE_H / 2} />
              {sensor.calibrated && sensor.limits.maxDepth < 100 && (
                <line
                  className="stp-track-limit-line"
                  x1="0"
                  y1={(sensor.limits.maxDepth / 100) * TRACE_H}
                  x2={TRACE_W}
                  y2={(sensor.limits.maxDepth / 100) * TRACE_H}
                />
              )}
              {lines.map((l, i) => (
                <polyline key={i} className="stp-track-line" points={l} />
              ))}
            </svg>
            <span className="stp-small stp-muted">last 10 s{sensor.calibrated ? "" : " · raw, auto-scaled"}</span>
          </div>
          <Meter position={position} maxDepth={sensor.limits.maxDepth} label="Calibrated position, 0 at rest, 100 deepest" />
        </div>
      )}
    </section>
  );
}

/** a vertical 0..100 meter (0 out at the top, 100 in at the bottom, like the guide) with the max-depth line */
function Meter(props: { position: number | undefined; maxDepth: number; label: string }) {
  const p = props.position;
  return (
    <div className="stp-sensor-meter" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p === undefined ? undefined : Math.round(p)}>
      <span className="stp-sensor-meter-label" style={{ top: 4 }}>
        0 out
      </span>
      <span className="stp-sensor-meter-label" style={{ bottom: 4 }}>
        100 in
      </span>
      {p !== undefined && <div className="stp-sensor-meter-fill" style={{ height: `${Math.max(0, Math.min(100, p))}%` }} />}
      {props.maxDepth < 100 && (
        <div className="stp-sensor-meter-limit" style={{ top: `${props.maxDepth}%` }} title={`Your max depth: ${props.maxDepth}`} />
      )}
    </div>
  );
}

// --- Calibrate ------------------------------------------------------------------------------

type CaptureKind = "rest" | "deep";

const WIZARD_STEPS = ["Rest position", "Deepest position", "Check & save"] as const;

function CalibrateTab(props: { sensor: TrackSensorHandle; onTab: (t: SensorTab) => void }) {
  const { sensor } = props;
  const connected = sensor.status?.connection === "connected";
  const [rest, setRest] = React.useState<Capture | undefined>(undefined);
  const [deep, setDeep] = React.useState<Capture | undefined>(undefined);
  const [capturing, setCapturing] = React.useState<{ kind: CaptureKind; start: number } | undefined>(undefined);
  const [note, setNote] = React.useState<string | undefined>(undefined);
  /** the wizard step shown: 0 rest, 1 deepest, 2 check & save */
  const [step, setStep] = React.useState(0);
  useTicker(capturing !== undefined, 100);

  React.useEffect(() => {
    if (!capturing) return;
    const buffer: DistanceSample[] = [];
    const off = sensor.subscribe((s) => buffer.push(s));
    const timer = window.setTimeout(() => {
      off();
      const c = captureFrom(buffer, capturing.start, capturing.start + CAPTURE_MS);
      if (!c) setNote("Too few readings in 1.5 s (a lost target doesn't count). Check that the sensor sees you, then capture again.");
      else if (capturing.kind === "rest") {
        setRest(c);
        setStep(1);
      } else {
        setDeep(c);
        setStep(2);
      }
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
    setStep(0);
    setNote(stored ? "Saved. Track clips use this mapping from now on." : "The browser blocked storage: the mapping applies until the page is reloaded.");
  };

  const restart = () => {
    setRest(undefined);
    setDeep(undefined);
    setStep(0);
    setNote(undefined);
  };

  const captureButton = (kind: CaptureKind, label: string) => (
    <button type="button" className="stp-btn stp-btn-orange stp-self-start" disabled={!connected || !!capturing} onClick={() => start(kind)}>
      {capturing?.kind === kind ? `Hold still… ${Math.round(progress * 100)}%` : label}
    </button>
  );

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
      <ol className="stp-wizard" aria-label="Calibration steps">
        {WIZARD_STEPS.map((label, i) => {
          const done = i === 0 ? !!rest : i === 1 ? !!deep : false;
          const reachable = i === 0 || (i === 1 && !!rest) || (i === 2 && !!rest && !!deep);
          return (
            <li key={label} className={`stp-wizard-step${step === i ? " is-current" : ""}${done ? " is-done" : ""}`}>
              <button type="button" disabled={!reachable || !!capturing} aria-current={step === i ? "step" : undefined} onClick={() => setStep(i)}>
                <span className="stp-wizard-num" aria-hidden="true">
                  {done ? "✓" : i + 1}
                </span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>
      {!connected && (
        <p className="stp-small stp-orange stp-lh">
          The sensor isn't connected.{" "}
          <button type="button" className="stp-linkbtn stp-orange" onClick={() => props.onTab("status")}>
            Connect it under Status
          </button>{" "}
          to calibrate.
        </p>
      )}
      <div className="stp-sensor-live">
        <div className="stp-col stp-gap-sm">
          {step === 0 && (
            <div className="stp-sensor-step">
              <span className="stp-strong">Rest position (0)</span>
              <span className="stp-small stp-soft stp-lh">
                Relax at your resting point and hold still. The page takes the median of 1.5 seconds of readings.
              </span>
              {rest && <span className="stp-mono stp-small">captured {fmt(rest.value)} ({rest.samples} readings)</span>}
              {captureButton("rest", rest ? "Capture rest again" : "Capture rest")}
            </div>
          )}
          {step === 1 && (
            <div className="stp-sensor-step">
              <span className="stp-strong">Deepest position (100)</span>
              <span className="stp-small stp-soft stp-lh">
                Only as deep as is comfortable, then hold still.
                {sensor.limits.maxDepth < 100
                  ? ` Scoring stops at your max depth (${Math.round(sensor.limits.maxDepth)}) of this point.`
                  : " Nothing deeper than this point is ever asked for or scored."}
              </span>
              {deep && <span className="stp-mono stp-small">captured {fmt(deep.value)} ({deep.samples} readings)</span>}
              {captureButton("deep", deep ? "Capture deepest again" : "Capture deepest")}
            </div>
          )}
          {step === 2 && (
            <div className="stp-sensor-step">
              <span className="stp-strong">Check & save</span>
              <span className="stp-small stp-soft stp-lh">
                Move between rest and your deepest point: the meter should run from 0 to 100. If it does, save.
              </span>
              <dl className="stp-kv">
                <dt>Rest</dt>
                <dd>{rest ? `${fmt(rest.value)} (${rest.samples} readings, spread ${fmt(rest.spread)})` : "—"}</dd>
                <dt>Deepest</dt>
                <dd>{deep ? `${fmt(deep.value)} (${deep.samples} readings, spread ${fmt(deep.spread)})` : "—"}</dd>
              </dl>
              <div className="stp-sensor-actions">
                <button type="button" className="stp-btn stp-btn-orange" disabled={!candidate || !!problem} onClick={save}>
                  Save calibration
                </button>
                <button type="button" className="stp-btn stp-btn-outline" onClick={restart}>
                  Start over
                </button>
              </div>
            </div>
          )}
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
          <div className="stp-row">
            <span className="stp-muted">{candidate ? "Position (new mapping)" : mapping ? "Position (saved mapping)" : "Position"}</span>
            <span className="stp-sensor-value">{position === undefined ? "—" : Math.round(position)}</span>
          </div>
          {sensor.calibration && step === 0 && !rest && (
            <div className="stp-sensor-actions">
              <button
                type="button"
                className="stp-btn stp-btn-outline stp-btn-sm"
                onClick={() => {
                  sensor.setCalibration(undefined);
                  setNote("The calibration is cleared. Track clips aren't scored until you calibrate again.");
                }}
              >
                Clear saved calibration
              </button>
            </div>
          )}
        </div>
        <Meter position={position} maxDepth={sensor.limits.maxDepth} label="Calibrated position, 0 at rest, 100 deepest" />
      </div>
    </section>
  );
}

// --- Range & limits -------------------------------------------------------------------------

type SaveState = { kind: "saved" | "error" | "manual"; text?: string } | undefined;

function RangeTab(props: { sensor: TrackSensorHandle }) {
  const { sensor } = props;
  const settings = usePluginSettings();
  const configurePlugin = useConfigurePlugin();
  const [form, setForm] = React.useState<RangeForm>(() => rangeFormFrom(settings));
  const [saveState, setSaveState] = React.useState<SaveState>(undefined);
  const parsed = parseRangeForm(form);
  const sample = sensor.latest();
  const connected = sensor.status?.connection === "connected";
  const preview = {
    ...(form.validMin.trim() !== "" && Number.isFinite(Number(form.validMin.replace(",", "."))) ? { validMin: Number(form.validMin.replace(",", ".")) } : {}),
    ...(form.validMax.trim() !== "" && Number.isFinite(Number(form.validMax.replace(",", "."))) ? { validMax: Number(form.validMax.replace(",", ".")) } : {}),
  };
  const set = (k: keyof RangeForm) => (e: ReactTypes.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [k]: e.currentTarget.value });
    setSaveState(undefined);
  };

  const save = async () => {
    if (!parsed.patch) return;
    if (!configurePlugin) {
      setSaveState({ kind: "manual" });
      return;
    }
    try {
      await configurePlugin({ variables: { plugin_id: PLUGIN_ID, input: mergeSettings(settings, parsed.patch) } });
      setSaveState({ kind: "saved" });
    } catch (err) {
      setSaveState({ kind: "error", text: errorText(err) });
    }
  };

  return (
    <>
      <section className="stp-panel" aria-labelledby="stp-sensor-range">
        <div className="stp-panel-head">
          <h2 id="stp-sensor-range" className="stp-caps">
            No-target range
          </h2>
          <span className="stp-small stp-muted">saved: valid {validRangeText(sensor.settings.config)}</span>
        </div>
        <p className="stp-small stp-soft stp-lh">
          Some sensors report a special value when they see nothing (too far away, nothing in front). Readings outside the
          valid range count as fully out instead of a position. For the Reach-Trainer, readings from 0 to 30 mean “no
          target”, so readings below 31 are ignored.
        </p>
        <div className="stp-form-grid">
          <label className="stp-field">
            No target below (raw)
            <input value={form.validMin} inputMode="decimal" placeholder="none" onChange={set("validMin")} />
          </label>
          <label className="stp-field">
            No target above (raw)
            <input value={form.validMax} inputMode="decimal" placeholder="none" onChange={set("validMax")} />
          </label>
        </div>
        <div className="stp-row stp-small">
          <span className="stp-muted">Reading now</span>
          <span className="stp-mono">
            {connected ? `${fmt(sample?.raw)} → ${rawVerdict(sample?.raw, preview)}` : "connect the sensor to check"}
          </span>
        </div>
      </section>

      <section className="stp-panel" aria-labelledby="stp-sensor-limits">
        <div className="stp-panel-head">
          <h2 id="stp-sensor-limits" className="stp-caps">
            Your limits
          </h2>
        </div>
        <p className="stp-small stp-soft stp-lh">
          Sections of a clip beyond your limits are still shown in the guide, but never scored, so a clip never asks for
          more than you set here. Stop a clip any time with Stop or Esc.
        </p>
        <div className="stp-form-grid">
          <label className="stp-field">
            Max depth (0–100, empty = 100)
            <input value={form.maxDepth} inputMode="decimal" placeholder="100" onChange={set("maxDepth")} />
          </label>
          <label className="stp-field">
            Max hold (seconds, empty = 8)
            <input value={form.maxHoldSec} inputMode="decimal" placeholder="8" onChange={set("maxHoldSec")} />
          </label>
        </div>
      </section>

      {parsed.problems.length > 0 && (
        <ul className="stp-small stp-orange" role="alert">
          {parsed.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="stp-sensor-actions">
        <button type="button" className="stp-btn stp-btn-orange" disabled={!parsed.patch} onClick={() => void save()}>
          Save range & limits
        </button>
        <button
          type="button"
          className="stp-btn stp-btn-outline"
          onClick={() => {
            setForm(rangeFormFrom(settings));
            setSaveState(undefined);
          }}
        >
          Undo changes
        </button>
      </div>
      {saveState?.kind === "saved" && (
        <p className="stp-small stp-blue" role="status">
          Saved. The sensor restarts with the new range; the limits apply to the next clip.
        </p>
      )}
      {saveState?.kind === "error" && (
        <p className="stp-small stp-error" role="alert">
          Couldn't save the settings: {saveState.text}. Enter them in Settings › Plugins › Skilltree instead.
        </p>
      )}
      {saveState?.kind === "manual" && (
        <p className="stp-small stp-soft" role="status">
          This stash can't save plugin settings from here. Enter them in Settings › Plugins › Skilltree (“Distance sensor
          valid minimum / maximum”, “Track max depth”, “Track max hold”).
        </p>
      )}
    </>
  );
}

// --- Find my sensor --------------------------------------------------------------------

interface Choice {
  service: string;
  characteristic: string;
  format: ValueFormat;
  offset: number;
}

function DeviceTab(props: { sensor: TrackSensorHandle }) {
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
        {current && (
          <span className="stp-small stp-muted stp-mono">
            {current.service} / {current.characteristic} · {current.format}
          </span>
        )}
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
            Saved. Connect the sensor under Status, then calibrate it.
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
                {(streams || ch.properties.read) && (
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

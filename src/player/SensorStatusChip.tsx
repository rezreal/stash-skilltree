// The distance sensor's state as a chip. In the play header it links to the
// sensor menu (or connects with one click, which the Bluetooth picker needs).
// In a session's bar (`onOpen` given) it never navigates - leaving the page
// would abort the clip - so it connects or opens the sensors panel instead.
import { router } from "./api.ts";
import { sensorChipView } from "./trackView.ts";
import { SENSOR_ROUTE, useTicker, useTrackSensor } from "./useTrack.ts";

export function SensorStatusChip(props: { onOpen?: () => void }) {
  const { Link } = router();
  const sensor = useTrackSensor();
  useTicker(sensor.status?.connection === "connecting", 1000);
  const view = sensorChipView(sensor.status, { configured: sensor.configured, calibrated: sensor.calibrated });
  const dot = <span className={props.onOpen ? "stp-sp-chip-dot" : "stp-dot"} aria-hidden="true" />;

  if (props.onOpen) {
    const onClick = view.action === "connect" ? sensor.connect : props.onOpen;
    return (
      <button type="button" className={`stp-sp-chip stp-sp-sensor stp-tone-${view.tone}`} onClick={onClick} title={view.title} aria-label={view.title}>
        {dot}
        <span>{view.label}</span>
      </button>
    );
  }
  if (view.action === "connect") {
    return (
      <button type="button" className={`stp-sensor-chip stp-tone-${view.tone}`} onClick={sensor.connect} title={view.title} disabled={!sensor.bluetooth}>
        {dot}
        {view.label}
      </button>
    );
  }
  const to = view.label === "Sensor · calibrate" ? `${SENSOR_ROUTE}?tab=calibrate` : SENSOR_ROUTE;
  return (
    <Link to={to} className={`stp-sensor-chip stp-tone-${view.tone}`} title={view.title}>
      {dot}
      {view.label}
    </Link>
  );
}

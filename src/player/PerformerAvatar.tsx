// A performer's stash image, loaded only when it scrolls into view. Falls back
// to initials when the image is missing or fails to load.
import { stashUrl } from "../stash/client.ts";
import { initials } from "./format.ts";

export function PerformerAvatar(props: { performerId: string; name: string; size?: number }) {
  const size = props.size ?? 44;
  const [failed, setFailed] = React.useState(false);
  const style = { width: size, height: size };
  if (failed) {
    return (
      <span className="stp-avatar stp-avatar-initials" style={style} aria-hidden="true">
        {initials(props.name)}
      </span>
    );
  }
  return (
    <img
      className="stp-avatar"
      style={style}
      src={stashUrl(`performer/${encodeURIComponent(props.performerId)}/image`)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

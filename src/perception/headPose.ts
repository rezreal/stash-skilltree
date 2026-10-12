// Head rotation from MediaPipe's facial transformation matrix. Pure.
//
// The matrix (FaceLandmarkerResult.facialTransformationMatrixes[i]) maps the
// canonical face model into camera space: right-handed, x to the image right,
// y up, z towards the camera (OpenGL convention). It is a 4x4 flattened
// column-major (MediaPipe's MatrixData default), may carry a uniform scale and
// a translation in the last column. The identity rotation is a face looking
// straight into the camera.
//
// We decompose R = Ry(yaw) · Rx(pitch') · Rz(roll) and report degrees:
//   yaw   > 0: nose turned towards the image right (in an unmirrored webcam
//              frame that is the viewer turning to their own left)
//   pitch > 0: nose up (pitch' is the opposite sign: Rx rotates the nose down)
//   roll  > 0: head tilted counter-clockwise as seen in the image
// For nod/shake only the changes matter; the signs are documented so they stay
// consistent.

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

const DEG = 180 / Math.PI;

/**
 * @param data 16 values (4x4) or 9 values (3x3)
 * @param layout element order of `data` (default column-major, as MediaPipe)
 */
export function headPoseFromMatrix(
  data: ArrayLike<number>,
  layout: "column-major" | "row-major" = "column-major",
): HeadPose | undefined {
  const n = data.length === 16 ? 4 : data.length === 9 ? 3 : 0;
  if (!n) return undefined;
  // r(row, col) of the upper-left 3x3
  const at = (row: number, col: number): number =>
    layout === "column-major" ? data[col * n + row] : data[row * n + col];
  // normalize each column to strip a uniform (or per-axis) scale
  const col: number[][] = [0, 1, 2].map((c) => {
    const v = [at(0, c), at(1, c), at(2, c)];
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > 0 ? v.map((x) => x / len) : v;
  });
  if (col.some((v) => v.some((x) => !Number.isFinite(x)))) return undefined;
  const r = (row: number, c: number): number => col[c][row];

  const s = Math.max(-1, Math.min(1, -r(1, 2)));
  const pitchP = Math.asin(s);
  let yaw: number;
  let roll: number;
  if (Math.abs(s) < 0.99999) {
    yaw = Math.atan2(r(0, 2), r(2, 2));
    roll = Math.atan2(r(1, 0), r(1, 1));
  } else {
    // gimbal lock (looking straight up/down): roll folds into yaw
    yaw = Math.atan2(-r(2, 0), r(0, 0));
    roll = 0;
  }
  return { yaw: yaw * DEG, pitch: -pitchP * DEG + 0, roll: roll * DEG };
}

/**
 * Builds the column-major 4x4 matrix for given angles (degrees, the same
 * conventions as headPoseFromMatrix). For tests and fakes.
 */
export function matrixFromHeadPose(p: HeadPose, scale = 1, t: [number, number, number] = [0, 0, 0]): number[] {
  const a = p.yaw / DEG;
  const b = -p.pitch / DEG;
  const c = p.roll / DEG;
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  const R = [
    [ca * cc + sa * sb * sc, -ca * sc + sa * sb * cc, sa * cb],
    [cb * sc, cb * cc, -sb],
    [-sa * cc + ca * sb * sc, sa * sc + ca * sb * cc, ca * cb],
  ];
  const out = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 4 + row] = R[row][col] * scale;
  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

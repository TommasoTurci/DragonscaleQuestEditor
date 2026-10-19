/**
 * A small software rasterizer for Minecraft block/item models.
 *
 * Minecraft inventory icons are not photographs of a 3D scene — they are an
 * orthographic projection of a handful of axis-aligned boxes through a fixed
 * transform declared by the model itself (`display.gui`). That makes them
 * reproducible without a GPU, a shader or a game:
 *
 *   1. each `element` is a box from/to in 0..16 block space
 *   2. each of its six `faces` carries a texture reference and a UV rectangle
 *   3. the whole model is rotated and scaled by `display.gui`
 *   4. faces are shaded by direction with Minecraft's fixed values
 *
 * Rendered at a multiple of the target size and box-filtered down, because the
 * rotated edges alias badly at 32px otherwise.
 */

const FACES = {
  // normal, the four corners in UV order (u1v1, u2v1, u2v2, u1v2), shading
  down:  { n: [0, -1, 0], shade: 0.50, corners: (a, b) => [[a[0],a[1],b[2]], [b[0],a[1],b[2]], [b[0],a[1],a[2]], [a[0],a[1],a[2]]] },
  up:    { n: [0,  1, 0], shade: 1.00, corners: (a, b) => [[a[0],b[1],a[2]], [b[0],b[1],a[2]], [b[0],b[1],b[2]], [a[0],b[1],b[2]]] },
  north: { n: [0, 0, -1], shade: 0.80, corners: (a, b) => [[b[0],b[1],a[2]], [a[0],b[1],a[2]], [a[0],a[1],a[2]], [b[0],a[1],a[2]]] },
  south: { n: [0, 0,  1], shade: 0.80, corners: (a, b) => [[a[0],b[1],b[2]], [b[0],b[1],b[2]], [b[0],a[1],b[2]], [a[0],a[1],b[2]]] },
  west:  { n: [-1, 0, 0], shade: 0.60, corners: (a, b) => [[a[0],b[1],a[2]], [a[0],b[1],b[2]], [a[0],a[1],b[2]], [a[0],a[1],a[2]]] },
  east:  { n: [1,  0, 0], shade: 0.60, corners: (a, b) => [[b[0],b[1],b[2]], [b[0],b[1],a[2]], [b[0],a[1],a[2]], [b[0],a[1],b[2]]] },
};

/** Default UVs come from the element's extent on the two axes the face spans. */
function defaultUv(face, a, b) {
  switch (face) {
    case 'down':
    case 'up':    return [a[0], a[2], b[0], b[2]];
    case 'north':
    case 'south': return [a[0], 16 - b[1], b[0], 16 - a[1]];
    case 'west':
    case 'east':  return [a[2], 16 - b[1], b[2], 16 - a[1]];
    default:      return [0, 0, 16, 16];
  }
}

const rad = d => d * Math.PI / 180;

function rotateAxis(v, axis, deg) {
  if (!deg) return v;
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  const [x, y, z] = v;
  if (axis === 'x') return [x, y * c - z * s, y * s + z * c];
  if (axis === 'y') return [x * c + z * s, y, -x * s + z * c];
  return [x * c - y * s, x * s + y * c, z];
}

/**
 * Renders one model.
 *
 * @param model     resolved model: { elements, textures, display }
 * @param resolve   (textureRef) -> decoded PNG ({width,height,data}) or null
 * @param size      output edge in pixels
 * @param ss        supersample factor
 * @returns {{width:number,height:number,data:Buffer}} RGBA, or null if nothing drew
 */
export function renderModel(model, resolve, size = 32, ss = 4) {
  const elements = model.elements ?? [];
  if (!elements.length) return null;

  const S = size * ss;
  const color = new Uint8ClampedArray(S * S * 4);
  const depth = new Float32Array(S * S).fill(Infinity);

  const gui = model.display?.gui ?? {};
  const rot = gui.rotation ?? [30, 225, 0];
  const scl = gui.scale ?? [0.625, 0.625, 0.625];
  const tr = gui.translation ?? [0, 0, 0];

  // Transform into view space, before any fitting.
  const view = (v) => {
    let p = [v[0] - 8, v[1] - 8, v[2] - 8];               // rotate about the centre
    p = [p[0] * scl[0], p[1] * scl[1], p[2] * scl[2]];
    p = rotateAxis(p, 'y', rot[1]);
    // Negated: the camera looks along +Z with nearer = smaller z, so a positive
    // rotation about X tips the top face away and the icon is seen from below.
    // Minecraft's convention is the opposite sign to this one.
    p = rotateAxis(p, 'x', -rot[0]);
    if (rot[2]) p = rotateAxis(p, 'z', -rot[2]);
    return [p[0] + tr[0], p[1] + tr[1], p[2] + tr[2]];
  };

  // Scale so a full 16-unit block fills the frame, which keeps relative sizes
  // honest — a slab should look like half a block, not like a block. Then shrink
  // if this particular model reaches further, since elements may sit outside 0..16.
  let reach = 0;
  for (const c of [0, 16]) for (const d of [0, 16]) for (const e of [0, 16]) {
    const p = view([c, d, e]);
    reach = Math.max(reach, Math.abs(p[0]), Math.abs(p[1]));
  }
  for (const el of elements) {
    if (!el.from || !el.to) continue;
    for (const c of [el.from[0], el.to[0]]) for (const d of [el.from[1], el.to[1]]) for (const e of [el.from[2], el.to[2]]) {
      const p = view([c, d, e]);
      reach = Math.max(reach, Math.abs(p[0]), Math.abs(p[1]));
    }
  }
  const fit = (S / 2) * 0.94 / (reach || 1);

  const project = (v) => {
    const p = view(v);
    return [S / 2 + p[0] * fit, S / 2 - p[1] * fit, p[2]];  // orthographic
  };

  let drew = false;

  for (const el of elements) {
    const a = el.from, b = el.to;
    if (!a || !b) continue;

    for (const [name, face] of Object.entries(el.faces ?? {})) {
      const spec = FACES[name];
      if (!spec) continue;
      const img = resolve(face.texture);
      if (!img) continue;

      let corners = spec.corners(a, b);

      // Per-element rotation, about its own origin.
      if (el.rotation) {
        const o = el.rotation.origin ?? [8, 8, 8];
        const ax = el.rotation.axis ?? 'y';
        const ang = el.rotation.angle ?? 0;
        corners = corners.map(c => {
          const r = rotateAxis([c[0] - o[0], c[1] - o[1], c[2] - o[2]], ax, ang);
          return [r[0] + o[0], r[1] + o[1], r[2] + o[2]];
        });
      }

      const uv = face.uv ?? defaultUv(name, a, b);
      let uvs = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
      // A face can declare its texture rotated in 90-degree steps.
      const steps = ((face.rotation ?? 0) / 90) | 0;
      for (let i = 0; i < steps; i++) uvs = [uvs[3], uvs[0], uvs[1], uvs[2]];

      const pts = corners.map(project);
      if (quad(color, depth, S, pts, uvs, img, spec.shade)) drew = true;
    }
  }

  return drew ? downsample(color, S, size, ss) : null;
}

/** Two triangles, barycentric, z-buffered, nearest-neighbour texturing. */
function quad(color, depth, S, p, uv, img, shade) {
  return tri(color, depth, S, [p[0], p[1], p[2]], [uv[0], uv[1], uv[2]], img, shade)
       | tri(color, depth, S, [p[0], p[2], p[3]], [uv[0], uv[2], uv[3]], img, shade);
}

function tri(color, depth, S, p, uv, img, shade) {
  const [p0, p1, p2] = p;
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (Math.abs(area) < 1e-9) return 0;

  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(S - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(S - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  let drew = 0;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((p1[0] - p0[0]) * (py - p0[1]) - (px - p0[0]) * (p1[1] - p0[1])) / area;
      const w1 = ((px - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (py - p0[1])) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;

      const z = p0[2] * w2 + p1[2] * w1 + p2[2] * w0;
      const di = y * S + x;
      if (z >= depth[di]) continue;

      const u = uv[0][0] * w2 + uv[1][0] * w1 + uv[2][0] * w0;
      const v = uv[0][1] * w2 + uv[1][1] * w1 + uv[2][1] * w0;

      // Textures are addressed in 0..16 regardless of their pixel size, and an
      // animated strip is a column of square frames: only frame 0 is wanted.
      const frame = Math.min(img.width, img.height);
      let tx = Math.floor(u / 16 * img.width);
      let ty = Math.floor(v / 16 * frame);
      tx = Math.min(img.width - 1, Math.max(0, tx));
      ty = Math.min(frame - 1, Math.max(0, ty));

      const si = (ty * img.width + tx) << 2;
      const alpha = img.data[si + 3];
      if (alpha < 8) continue;

      depth[di] = z;
      const ci = di << 2;
      color[ci]     = img.data[si]     * shade;
      color[ci + 1] = img.data[si + 1] * shade;
      color[ci + 2] = img.data[si + 2] * shade;
      color[ci + 3] = alpha;
      drew = 1;
    }
  }
  return drew;
}

function downsample(src, S, size, ss) {
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * S + (x * ss + dx)) << 2;
          const w = src[i + 3] / 255;
          r += src[i] * w; g += src[i + 1] * w; b += src[i + 2] * w; a += src[i + 3];
        }
      }
      const o = (y * size + x) << 2;
      const wsum = a / 255 || 1;
      out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / n;
    }
  }
  return { width: size, height: size, data: out };
}

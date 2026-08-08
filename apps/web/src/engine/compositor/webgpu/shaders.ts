/** WGSL modules for the WebGPU compositor. */

export const FULLSCREEN_VERTEX = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}
`;

export const LAYER_SHADER = /* wgsl */ `
struct Uniforms {
  mvp: mat4x4f,
  color0: vec4f,
  color1: vec4f,
  // mask bounds x,y,w,h in clip texture UV (0..1)
  color2: vec4f,
  // mask: feather, inverted, opacity, shape (-1=off, 0=rect, 1=ellipse)
  color3: vec4f,
  // chroma: keyR, keyG, keyB, enabled (0/1)
  color4: vec4f,
  // chroma: similarity, smoothness, spill, _pad
  color5: vec4f,
  // crop: x, y, width, height in source texture UV (0..1)
  color6: vec4f,
  // primary grade: exposure EV, contrast %, saturation %, temperature
  color7: vec4f,
  // primary grade: tint, shadows %, highlights %, blacks %
  color8: vec4f,
  // primary grade: whites %, vibrance %, _pad, _pad
  color9: vec4f,
  // color-curve point counts: luma, red, green, blue
  color10: vec4f,
  // Four vec4 values per channel; each vec4 packs two (x,y) points.
  curveLuma: array<vec4f, 4>,
  curveRed: array<vec4f, 4>,
  curveGreen: array<vec4f, 4>,
  curveBlue: array<vec4f, 4>,
  // HSL secondary: hue center/range in degrees, saturation min/max
  color11: vec4f,
  // HSL secondary: lightness min/max, feather, hue shift degrees
  color12: vec4f,
  // HSL secondary: saturation shift %, lightness shift %, mix, _pad
  color13: vec4f,
  // Lift wheel: red, green, blue, master
  color14: vec4f,
  // Gamma wheel: red, green, blue, master
  color15: vec4f,
  // Gain wheel: red, green, blue, master
  color16: vec4f,
  // Levels: input black, input white, midtone gamma, output black
  color17: vec4f,
  // Levels: output white, _pad, _pad, _pad
  color18: vec4f,
  // 3D layer normal xyz and ambient intensity
  color19: vec4f,
  // key-light direction xyz and intensity
  color20: vec4f,
  // key-light RGB and enabled
  color21: vec4f,
  // input transform: profile (0=Rec.709, 1=S-Log3, 2=HLG), exposure compensation EV
  color22: vec4f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VertexIn {
  @location(0) position: vec2f,
  @location(1) uv: vec2f,
  // Per-corner projective denominator. One for ordinary transformed layers.
  @location(2) perspective: f32,
}

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

fn rgb2hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, vec3f(0.0), vec3f(1.0)), c.y);
}

fn rgb2hsl(c: vec3f) -> vec3f {
  let maxC = max(c.r, max(c.g, c.b));
  let minC = min(c.r, min(c.g, c.b));
  let delta = maxC - minC;
  let lightness = (maxC + minC) * 0.5;
  if (delta < 1e-5) {
    return vec3f(0.0, 0.0, lightness);
  }
  var hue = 0.0;
  if (maxC == c.r) {
    hue = fract((c.g - c.b) / delta / 6.0);
  } else if (maxC == c.g) {
    hue = ((c.b - c.r) / delta + 2.0) / 6.0;
  } else {
    hue = ((c.r - c.g) / delta + 4.0) / 6.0;
  }
  let saturation = delta / max(1.0 - abs(2.0 * lightness - 1.0), 1e-5);
  return vec3f(fract(hue), clamp(saturation, 0.0, 1.0), lightness);
}

fn hsl2rgb(hsl: vec3f) -> vec3f {
  let hue = fract(hsl.x);
  let saturation = clamp(hsl.y, 0.0, 1.0);
  let lightness = clamp(hsl.z, 0.0, 1.0);
  let chroma = (1.0 - abs(2.0 * lightness - 1.0)) * saturation;
  let h6 = hue * 6.0;
  let x = chroma * (1.0 - abs(fract(h6 * 0.5) * 2.0 - 1.0));
  var rgb = vec3f(0.0);
  if (h6 < 1.0) {
    rgb = vec3f(chroma, x, 0.0);
  } else if (h6 < 2.0) {
    rgb = vec3f(x, chroma, 0.0);
  } else if (h6 < 3.0) {
    rgb = vec3f(0.0, chroma, x);
  } else if (h6 < 4.0) {
    rgb = vec3f(0.0, x, chroma);
  } else if (h6 < 5.0) {
    rgb = vec3f(x, 0.0, chroma);
  } else {
    rgb = vec3f(chroma, 0.0, x);
  }
  return rgb + vec3f(lightness - chroma * 0.5);
}

fn rangeMask(value: f32, lower: f32, upper: f32, feather: f32) -> f32 {
  let softness = max(feather * 0.2, 0.001);
  return smoothstep(lower - softness, lower + softness, value) *
    (1.0 - smoothstep(upper - softness, upper + softness, value));
}

fn unpackCurvePoint(curve: array<vec4f, 4>, index: i32) -> vec2f {
  let pair = curve[u32(index / 2)];
  return select(pair.zw, pair.xy, index % 2 == 0);
}

fn sampleCurve(curve: array<vec4f, 4>, pointCount: f32, value: f32) -> f32 {
  let count = clamp(i32(round(pointCount)), 2, 8);
  let x = clamp(value, 0.0, 1.0);
  var previous = unpackCurvePoint(curve, 0);
  for (var index = 1; index < 8; index++) {
    if (index >= count) {
      break;
    }
    let next = unpackCurvePoint(curve, index);
    if (x <= next.x) {
      let t = clamp((x - previous.x) / max(next.x - previous.x, 1e-5), 0.0, 1.0);
      return mix(previous.y, next.y, t);
    }
    previous = next;
  }
  return previous.y;
}

fn rgbToCbCr(c: vec3f) -> vec2f {
  let y = dot(c, vec3f(0.299, 0.587, 0.114));
  return vec2f(0.564 * (c.b - y), 0.713 * (c.r - y));
}

fn chromaMatte(rgb: vec3f) -> f32 {
  if (u.color4.w < 0.5) {
    return 1.0;
  }
  let key = u.color4.xyz;
  let p = rgbToCbCr(rgb);
  let k = rgbToCbCr(key);
  let d = length(p - k);
  let similarity = clamp(u.color5.x, 0.0, 1.0);
  let smoothness = clamp(u.color5.y, 0.0, 1.0);
  let thresh = similarity * 0.55;
  let soft = max(smoothness * 0.35, 1e-5);
  return smoothstep(thresh, thresh + soft, d);
}

fn spillSuppress(rgb: vec3f, matte: f32) -> vec3f {
  if (u.color4.w < 0.5) {
    return rgb;
  }
  let spill = clamp(u.color5.z, 0.0, 1.0);
  let amount = spill * (1.0 - clamp(matte, 0.0, 1.0));
  if (amount < 1e-6) {
    return rgb;
  }
  let key = u.color4.xyz;
  let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  var out = rgb;
  if (key.g >= key.r && key.g >= key.b) {
    out.g = mix(out.g, luma, amount);
  } else if (key.b >= key.r && key.b >= key.g) {
    out.b = mix(out.b, luma, amount);
  } else {
    out.r = mix(out.r, luma, amount);
  }
  return clamp(out, vec3f(0.0), vec3f(1.0));
}

fn rec709Encode(linear: f32) -> f32 {
  let c = max(linear, 0.0);
  return select(1.099 * pow(c, 0.45) - 0.099, c * 4.5, c < 0.018);
}

fn slog3ToLinear(code: f32) -> f32 {
  let c = clamp(code, 0.0, 1.0);
  // Sony S-Log3 inverse OETF, normalized 10-bit code values.
  return select(
    (pow(10.0, (c * 1023.0 - 420.0) / 261.5) * 0.19) - 0.01,
    (c * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0),
    c < 0.167360992
  );
}

fn hlgToLinear(code: f32) -> f32 {
  let c = clamp(code, 0.0, 1.0);
  let a = 0.17883277;
  let b = 0.28466892;
  let gamma = 0.55991073;
  return select((exp((c - gamma) / a) + b) / 12.0, c * c / 3.0, c <= 0.5);
}

fn applyInputTransform(rgb: vec3f, profile: f32, exposure: f32) -> vec3f {
  if (profile < 0.5) { return rgb; }
  var linear = rgb;
  if (profile < 1.5) {
    linear = vec3f(slog3ToLinear(rgb.r), slog3ToLinear(rgb.g), slog3ToLinear(rgb.b));
  } else {
    linear = vec3f(hlgToLinear(rgb.r), hlgToLinear(rgb.g), hlgToLinear(rgb.b));
  }
  linear = max(linear * exp2(exposure), vec3f(0.0));
  return vec3f(rec709Encode(linear.r), rec709Encode(linear.g), rec709Encode(linear.b));
}

fn applyColor(rgb: vec3f) -> vec3f {
  var c = applyInputTransform(rgb, u.color22.x, u.color22.y);
  let brightness = u.color0.x;
  let contrast = u.color0.y;
  let sat = u.color0.z;
  let hueDeg = u.color0.w;
  let grayAmt = u.color1.x / 100.0;
  let sepiaAmt = u.color1.y / 100.0;
  let invertAmt = u.color1.z / 100.0;
  let gradeExposure = u.color7.x;
  let gradeContrast = u.color7.y / 100.0;
  let gradeSaturation = u.color7.z / 100.0;
  let gradeTemperature = u.color7.w / 100.0;
  let gradeTint = u.color8.x / 100.0;
  let gradeShadows = u.color8.y / 100.0;
  let gradeHighlights = u.color8.z / 100.0;
  let gradeBlacks = u.color8.w / 100.0;
  let gradeWhites = u.color9.x / 100.0;
  let gradeVibrance = u.color9.y / 100.0;
  let secondaryHueCenter = u.color11.x;
  let secondaryHueRange = u.color11.y;
  let secondarySaturationMin = u.color11.z;
  let secondarySaturationMax = u.color11.w;
  let secondaryLightnessMin = u.color12.x;
  let secondaryLightnessMax = u.color12.y;
  let secondaryFeather = u.color12.z;
  let secondaryHueShift = u.color12.w;
  let secondarySaturationShift = u.color13.x / 100.0;
  let secondaryLightnessShift = u.color13.y / 100.0;
  let secondaryMix = u.color13.z;
  let liftControl = clamp(u.color14.rgb + vec3f(u.color14.w), vec3f(-1.0), vec3f(1.0));
  let gammaControl = clamp(u.color15.rgb + vec3f(u.color15.w), vec3f(-0.95), vec3f(1.0));
  let gainControl = clamp(u.color16.rgb + vec3f(u.color16.w), vec3f(-0.95), vec3f(1.0));
  let inputBlack = u.color17.x;
  let inputWhite = u.color17.y;
  let levelsGamma = u.color17.z;
  let outputBlack = u.color17.w;
  let outputWhite = u.color18.x;

  c = c * brightness;
  c = (c - 0.5) * contrast + 0.5;

  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(luma), c, sat);

  if (abs(hueDeg) > 0.001) {
    var hsv = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
    hsv.x = fract(hsv.x + hueDeg / 360.0);
    c = hsv2rgb(hsv);
  }

  // Primary correction runs in linear-looking working values before creative
  // stylizers. The masks keep shadow/highlight controls localized instead of
  // shifting the whole image like brightness does.
  c = c * exp2(gradeExposure);
  c = (c - 0.5) * max(0.0, 1.0 + gradeContrast) + 0.5;
  let gradeLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(gradeLuma), c, max(0.0, 1.0 + gradeSaturation));

  // Positive temperature adds amber; positive tint adds magenta.
  c += vec3f(
    gradeTemperature * 0.18 + gradeTint * 0.09,
    -gradeTint * 0.12,
    -gradeTemperature * 0.18 + gradeTint * 0.09
  );

  let tonalLuma = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  let shadowMask = 1.0 - smoothstep(0.0, 0.55, tonalLuma);
  let highlightMask = smoothstep(0.45, 1.0, tonalLuma);
  let blackMask = 1.0 - smoothstep(0.0, 0.24, tonalLuma);
  let whiteMask = smoothstep(0.76, 1.0, tonalLuma);
  c += vec3f(gradeShadows * 0.30 * shadowMask);
  c += vec3f(gradeHighlights * 0.30 * highlightMask);
  c += vec3f(gradeBlacks * 0.18 * blackMask);
  c += vec3f(gradeWhites * 0.18 * whiteMask);

  if (abs(gradeVibrance) > 0.001) {
    var gradeHsv = rgb2hsv(clamp(c, vec3f(0.0), vec3f(1.0)));
    if (gradeVibrance > 0.0) {
      gradeHsv.y = clamp(
        gradeHsv.y + gradeVibrance * (1.0 - gradeHsv.y),
        0.0,
        1.0
      );
    } else {
      gradeHsv.y = clamp(gradeHsv.y * (1.0 + gradeVibrance), 0.0, 1.0);
    }
    c = hsv2rgb(gradeHsv);
  }

  // Lift offsets the dark end, gamma shapes the midtones, and gain scales
  // highlights. RGB wheel values are deliberately combined with the master
  // control per channel, preserving a neutral zero position for every wheel.
  c = clamp(c + liftControl * 0.25, vec3f(0.0), vec3f(1.0));
  c = pow(max(c, vec3f(1e-5)), vec3f(1.0) / (vec3f(1.0) + gammaControl));
  c = clamp(c * (vec3f(1.0) + gainControl), vec3f(0.0), vec3f(1.0));

  // Levels remaps source black/white, bends the midtone pivot, then maps to
  // the requested output floor/ceiling. It runs before secondary qualification
  // so targeted corrections work against the corrected tonal range.
  let levelSpan = max(inputWhite - inputBlack, 1e-4);
  c = clamp((c - vec3f(inputBlack)) / levelSpan, vec3f(0.0), vec3f(1.0));
  c = pow(max(c, vec3f(1e-5)), vec3f(1.0 / max(levelsGamma, 0.1)));
  c = mix(vec3f(outputBlack), vec3f(outputWhite), c);

  // Qualify in HSL after primary balancing, then mix a targeted correction.
  // Hue distance wraps at red so a warm key can cross the 0°/360° boundary.
  if (secondaryMix > 0.001) {
    let hsl = rgb2hsl(clamp(c, vec3f(0.0), vec3f(1.0)));
    let hueDistance = abs(fract(hsl.x - secondaryHueCenter / 360.0 + 0.5) - 0.5) * 360.0;
    let hueSoftness = max(secondaryFeather * 30.0, 0.05);
    let hueMask = 1.0 - smoothstep(
      secondaryHueRange,
      max(secondaryHueRange + hueSoftness, secondaryHueRange + 0.05),
      hueDistance
    );
    let qualifier = hueMask *
      rangeMask(hsl.y, secondarySaturationMin, secondarySaturationMax, secondaryFeather) *
      rangeMask(hsl.z, secondaryLightnessMin, secondaryLightnessMax, secondaryFeather);
    let adjusted = vec3f(
      fract(hsl.x + secondaryHueShift / 360.0),
      clamp(hsl.y * (1.0 + secondarySaturationShift), 0.0, 1.0),
      clamp(hsl.z + secondaryLightnessShift, 0.0, 1.0)
    );
    c = mix(c, hsl2rgb(adjusted), clamp(qualifier * secondaryMix, 0.0, 1.0));
  }

  // Luma is applied first to preserve chroma relationships; RGB curves then
  // give colorists channel-level control for split-toning and cast correction.
  let sourceLuma = max(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 1e-5);
  let curvedLuma = sampleCurve(u.curveLuma, u.color10.x, sourceLuma);
  c = c * (curvedLuma / sourceLuma);
  c = vec3f(
    sampleCurve(u.curveRed, u.color10.y, c.r),
    sampleCurve(u.curveGreen, u.color10.z, c.g),
    sampleCurve(u.curveBlue, u.color10.w, c.b)
  );

  let g = vec3f(dot(c, vec3f(0.2126, 0.7152, 0.0722)));
  c = mix(c, g, clamp(grayAmt, 0.0, 1.0));

  let sepia = vec3f(
    dot(c, vec3f(0.393, 0.769, 0.189)),
    dot(c, vec3f(0.349, 0.686, 0.168)),
    dot(c, vec3f(0.272, 0.534, 0.131))
  );
  c = mix(c, sepia, clamp(sepiaAmt, 0.0, 1.0));

  let inv = 1.0 - c;
  c = mix(c, inv, clamp(invertAmt, 0.0, 1.0));
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

fn applyLayerLighting(rgb: vec3f) -> vec3f {
  if (u.color21.w < 0.5) { return rgb; }
  let normal = normalize(u.color19.xyz);
  let direction = normalize(u.color20.xyz);
  let diffuse = max(dot(normal, direction), 0.0);
  let light = vec3f(max(u.color19.w, 0.0)) + u.color21.xyz * max(u.color20.w, 0.0) * diffuse;
  return rgb * light;
}

fn sdBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn maskFactor(uv: vec2f) -> f32 {
  let shape = u.color3.w;
  if (shape < -0.5) {
    return 1.0;
  }
  let bx = u.color2.x;
  let by = u.color2.y;
  let bw = max(u.color2.z, 0.0001);
  let bh = max(u.color2.w, 0.0001);
  let cx = bx + bw * 0.5;
  let cy = by + bh * 0.5;
  let feather = max(u.color3.x, 0.0001);
  let inverted = u.color3.y > 0.5;
  let mop = clamp(u.color3.z, 0.0, 1.0);
  var inside = 0.0;
  if (shape > 0.5) {
    let halfMin = min(bw, bh) * 0.5;
    let featherR = feather / max(halfMin, 0.0001);
    let p = (uv - vec2f(cx, cy)) / vec2f(bw * 0.5, bh * 0.5);
    let d = length(p) - 1.0;
    inside = 1.0 - smoothstep(-featherR, featherR, d);
  } else {
    let p = uv - vec2f(cx, cy);
    let d = sdBox(p, vec2f(bw * 0.5, bh * 0.5));
    inside = 1.0 - smoothstep(-feather, feather, d);
  }
  var m = inside;
  if (inverted) {
    m = 1.0 - m;
  }
  return m * mop;
}

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  var out: VertexOut;
  let clip = u.mvp * vec4f(input.position, 0.0, 1.0);
  // Varying clip-space W gives the rasterizer perspective-correct UVs. It
  // makes a four-corner pin a real homography instead of two affine triangles.
  out.position = clip * input.perspective;
  out.uv = input.uv;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let cropUv = u.color6.xy + input.uv * u.color6.zw;
  let sample = textureSample(tex, samp, cropUv);
  let matte = chromaMatte(sample.rgb);
  let spilled = spillSuppress(sample.rgb, matte);
  let rgb = applyLayerLighting(applyColor(spilled));
  let a = sample.a * u.color1.w * matte * maskFactor(input.uv);
  return vec4f(rgb * a, a);
}
`;

export const BLUR_SHADER = /* wgsl */ `
struct BlurUniforms {
  direction: vec2f,
  radius: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> u: BlurUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(tex));
  let texel = u.direction / dims;
  var sum = vec4f(0.0);
  var wsum = 0.0;
  let r = i32(clamp(u.radius, 0.0, 24.0));
  for (var i = -24; i <= 24; i++) {
    if (abs(i) > r) { continue; }
    let fi = f32(i);
    let sigma = max(u.radius * 0.5, 0.5);
    let w = exp(-(fi * fi) / (2.0 * sigma * sigma));
    sum += textureSample(tex, samp, input.uv + texel * fi) * w;
    wsum += w;
  }
  return sum / max(wsum, 0.0001);
}
`;

export const COMPOSITE_SHADER = /* wgsl */ `
struct CompUniforms {
  params: vec4f,
}

@group(0) @binding(0) var<uniform> u: CompUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var layerTex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

fn blendFn(mode: i32, base: vec3f, blendc: vec3f) -> vec3f {
  if (mode == 1) { return base * blendc; }
  if (mode == 2) { return 1.0 - (1.0 - base) * (1.0 - blendc); }
  if (mode == 3) {
    return select(2.0 * base * blendc, 1.0 - 2.0 * (1.0 - base) * (1.0 - blendc), base > vec3f(0.5));
  }
  if (mode == 4) { return min(base, blendc); }
  if (mode == 5) { return max(base, blendc); }
  if (mode == 6) { return abs(base - blendc); }
  if (mode == 7) { return base + blendc - 2.0 * base * blendc; }
  if (mode == 8) { // color-dodge
    return select(vec3f(1.0), min(vec3f(1.0), base / max(1.0 - blendc, vec3f(0.0001))), blendc < vec3f(1.0));
  }
  if (mode == 9) { // color-burn
    return select(vec3f(0.0), 1.0 - min(vec3f(1.0), (1.0 - base) / max(blendc, vec3f(0.0001))), blendc > vec3f(0.0));
  }
  if (mode == 10) { // hard-light
    return select(2.0 * base * blendc, 1.0 - 2.0 * (1.0 - base) * (1.0 - blendc), blendc < vec3f(0.5));
  }
  if (mode == 11) { // soft-light (approx)
    let d = select(
      ((16.0 * base - 12.0) * base + 4.0) * base,
      sqrt(base),
      base > vec3f(0.25)
    );
    return select(
      base - (1.0 - 2.0 * blendc) * base * (1.0 - base),
      base + (2.0 * blendc - 1.0) * (d - base),
      blendc <= vec3f(0.5)
    );
  }
  return blendc;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let dst = textureSample(sceneTex, samp, input.uv);
  let src = textureSample(layerTex, samp, input.uv);
  let mode = i32(u.params.x);
  let opacity = u.params.y;

  let srcA = clamp(src.a * opacity, 0.0, 1.0);
  let srcRgb = select(src.rgb / max(src.a, 0.0001), vec3f(0.0), src.a < 0.0001);
  let dstRgb = select(dst.rgb / max(dst.a, 0.0001), vec3f(0.0), dst.a < 0.0001);

  var outRgb: vec3f;
  if (mode == 0) {
    outRgb = srcRgb;
  } else {
    outRgb = blendFn(mode, dstRgb, srcRgb);
  }

  let outA = srcA + dst.a * (1.0 - srcA);
  let mixed = outRgb * srcA + dstRgb * dst.a * (1.0 - srcA);
  let finalRgb = select(mixed / max(outA, 0.0001), vec3f(0.0), outA < 0.0001);
  return vec4f(finalRgb * outA, outA);
}
`;

/** Applies an alpha or luma matte to a pre-multiplied rendered layer. */
export const TRACK_MATTE_SHADER = /* wgsl */ `
struct MatteUniforms {
  // x: 0 = alpha, 1 = luma; y: threshold (-1 keeps raw matte);
  // z: feather; w: invert (0/1)
  params: vec4f,
  // x: soft matte choke/expand (-0.5..0.5), remaining padding
  choke: vec4f,
  // garbage matte bounds x,y,w,h; style feather,inverted,opacity,shape (-1 off)
  garbageBounds: vec4f,
  garbageStyle: vec4f,
  // holdout matte bounds x,y,w,h; style feather,inverted,opacity,shape (-1 off)
  holdoutBounds: vec4f,
  holdoutStyle: vec4f,
}

@group(0) @binding(0) var<uniform> u: MatteUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sourceTex: texture_2d<f32>;
@group(0) @binding(3) var matteTex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0), vec2f(2.0, 1.0), vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

fn boxDistance(p: vec2f, halfSize: vec2f) -> f32 {
  let d = abs(p) - halfSize;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn regionAmount(uv: vec2f, bounds: vec4f, style: vec4f) -> f32 {
  if (style.w < -0.5 || bounds.z <= 0.0 || bounds.w <= 0.0) { return 1.0; }
  let center = bounds.xy + bounds.zw * 0.5;
  let feather = max(style.x, 0.0001);
  var inside = 0.0;
  if (style.w > 0.5) {
    let normalized = (uv - center) / max(bounds.zw * 0.5, vec2f(0.0001));
    inside = 1.0 - smoothstep(1.0 - feather * 2.0, 1.0 + feather * 2.0, length(normalized));
  } else {
    inside = 1.0 - smoothstep(-feather, feather, boxDistance(uv - center, bounds.zw * 0.5));
  }
  if (style.y > 0.5) { inside = 1.0 - inside; }
  return inside * style.z;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let source = textureSample(sourceTex, samp, input.uv);
  let matte = textureSample(matteTex, samp, input.uv);
  let matteRgb = select(matte.rgb / max(matte.a, 0.0001), vec3f(0.0), matte.a < 0.0001);
  let luma = dot(matteRgb, vec3f(0.2126, 0.7152, 0.0722)) * matte.a;
  var amount = select(clamp(matte.a, 0.0, 1.0), clamp(luma, 0.0, 1.0), u.params.x > 0.5);
  amount = clamp(amount + u.choke.x, 0.0, 1.0);
  if (u.params.y >= 0.0) {
    let feather = max(u.params.z, 0.0001);
    amount = smoothstep(u.params.y - feather, u.params.y + feather, amount);
  }
  if (u.params.w > 0.5) {
    amount = 1.0 - amount;
  }
  // Garbage matte limits the usable region; holdout removes an unwanted
  // portion, which is essential for hands, reflections, and overlaps.
  amount = amount * regionAmount(input.uv, u.garbageBounds, u.garbageStyle);
  amount = amount * (1.0 - select(regionAmount(input.uv, u.holdoutBounds, u.holdoutStyle), 0.0, u.holdoutStyle.w < -0.5));
  return source * amount;
}
`;

export const PRESENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, input.uv);
  let rgb = select(c.rgb / max(c.a, 0.0001), vec3f(0.0), c.a < 0.0001);
  return vec4f(rgb, 1.0);
}
`;

/** Bright-pass extract for soft glow */
export const GLOW_EXTRACT_SHADER = /* wgsl */ `
struct GlowUniforms {
  params: vec4f, // threshold, intensity, _pad, _pad
}

@group(0) @binding(0) var<uniform> u: GlowUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, input.uv);
  let luma = dot(c.rgb, vec3f(0.2126, 0.7152, 0.0722));
  let t = u.params.x;
  let bright = max(luma - t, 0.0) / max(1.0 - t, 0.0001);
  let rgb = c.rgb * bright;
  return vec4f(rgb, c.a * bright);
}
`;

/** Additive composite: base + intensity * bloom */
export const GLOW_COMPOSITE_SHADER = /* wgsl */ `
struct GlowUniforms {
  params: vec4f, // intensity, 0, 0, 0
}

@group(0) @binding(0) var<uniform> u: GlowUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var baseTex: texture_2d<f32>;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let base = textureSample(baseTex, samp, input.uv);
  let bloom = textureSample(bloomTex, samp, input.uv);
  let intensity = u.params.x;
  let rgb = clamp(base.rgb + bloom.rgb * intensity, vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, base.a);
}
`;

/** 3D LUT apply with intensity mix */
export const LUT3D_SHADER = /* wgsl */ `
struct LutUniforms {
  params: vec4f, // intensity, sizeHint, 0, 0
}

@group(0) @binding(0) var<uniform> u: LutUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var lutTex: texture_3d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, input.uv);
  let rgb = select(c.rgb / max(c.a, 0.0001), vec3f(0.0), c.a < 0.0001);
  let graded = textureSample(lutTex, samp, clamp(rgb, vec3f(0.0), vec3f(1.0))).rgb;
  let mixed = mix(rgb, graded, clamp(u.params.x, 0.0, 1.0));
  return vec4f(mixed * c.a, c.a);
}
`;

/** Vignette + film grain (grain last in stack) */
export const POST_FX_SHADER = /* wgsl */ `
struct PostUniforms {
  vignette: vec4f, // amount, softness, 0, 0
  grain: vec4f,    // amount, size, time, 0
  detail: vec4f,   // clarity, dehaze, sharpen, 0
  stylize: vec4f,  // posterizeLevels, aberration, lightLeak, leakPosition
}

@group(0) @binding(0) var<uniform> u: PostUniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

fn hash21(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  var c = textureSample(tex, samp, input.uv);
  if (u.stylize.y > 0.001) {
    let offset = vec2f(u.stylize.y * 0.003, 0.0);
    c = vec4f(
      textureSample(tex, samp, input.uv + offset).r,
      c.g,
      textureSample(tex, samp, input.uv - offset).b,
      c.a
    );
  }
  var rgb = select(c.rgb / max(c.a, 0.0001), vec3f(0.0), c.a < 0.0001);

  // Local unsharp mask plus restrained midtone contrast. This runs after the
  // grade/LUT so detail controls enhance the resulting look consistently.
  let dims = vec2f(textureDimensions(tex));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let neighbors = (
    textureSample(tex, samp, input.uv + vec2f(texel.x, 0.0)).rgb +
    textureSample(tex, samp, input.uv - vec2f(texel.x, 0.0)).rgb +
    textureSample(tex, samp, input.uv + vec2f(0.0, texel.y)).rgb +
    textureSample(tex, samp, input.uv - vec2f(0.0, texel.y)).rgb
  ) * 0.25;
  let unpremulNeighbors = neighbors / max(c.a, 0.0001);
  if (u.detail.z > 0.001) {
    rgb = clamp(rgb + (rgb - unpremulNeighbors) * u.detail.z, vec3f(0.0), vec3f(1.0));
  }
  if (abs(u.detail.x) > 0.001) {
    let luma = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    let detail = rgb - vec3f(luma);
    rgb = clamp(rgb + detail * u.detail.x * 0.65, vec3f(0.0), vec3f(1.0));
  }
  if (u.detail.y > 0.001) {
    let contrast = 1.0 + u.detail.y * 0.75;
    rgb = clamp((rgb - vec3f(0.5)) * contrast + vec3f(0.5), vec3f(0.0), vec3f(1.0));
  }

  if (u.stylize.x > 1.0) {
    let levels = max(2.0, floor(u.stylize.x));
    rgb = floor(rgb * (levels - 1.0) + vec3f(0.5)) / (levels - 1.0);
  }
  if (u.stylize.z > 0.001) {
    let center = vec2f(u.stylize.w, 0.18);
    let d = length(input.uv - center);
    let leak = smoothstep(0.8, 0.0, d) * u.stylize.z;
    rgb = clamp(rgb + vec3f(1.0, 0.26, 0.05) * leak, vec3f(0.0), vec3f(1.0));
  }

  let amount = u.vignette.x;
  let soft = max(u.vignette.y, 0.001);
  if (amount > 0.001) {
    let d = length(input.uv - vec2f(0.5, 0.5)) * 1.41421356;
    let edge = 1.0 - soft;
    let vig = smoothstep(edge, 1.0, d);
    rgb = rgb * (1.0 - amount * vig);
  }

  let gAmt = u.grain.x;
  if (gAmt > 0.001) {
    let gSize = max(u.grain.y, 0.5);
    let cell = floor(input.uv * dims / gSize);
    let n = hash21(cell + vec2f(u.grain.z, u.grain.z * 1.7));
    let noise = (n - 0.5) * 2.0 * gAmt;
    rgb = clamp(rgb + vec3f(noise), vec3f(0.0), vec3f(1.0));
  }

  return vec4f(rgb * c.a, c.a);
}
`;

/** Geometric A/B mix: wipe=0, push=1, whip=2, iris=3. */
export const TRANSITION_MIX_SHADER = /* wgsl */ `
struct Uniforms {
  // x=progress, y=kind, z=direction (0 L,1 R,2 U,3 D), w=softness|blur
  u: vec4f,
  // x=centerX, y=centerY, z=blur (whip), w=aspect (width/height)
  v: vec4f,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

fn pushOffsets(progress: f32, dir: f32) -> array<vec2f, 2> {
  var offA = vec2f(0.0);
  var offB = vec2f(0.0);
  if (dir < 0.5) {
    offA = vec2f(-progress, 0.0);
    offB = vec2f(1.0 - progress, 0.0);
  } else if (dir < 1.5) {
    offA = vec2f(progress, 0.0);
    offB = vec2f(-(1.0 - progress), 0.0);
  } else if (dir < 2.5) {
    offA = vec2f(0.0, -progress);
    offB = vec2f(0.0, 1.0 - progress);
  } else {
    offA = vec2f(0.0, progress);
    offB = vec2f(0.0, -(1.0 - progress));
  }
  return array<vec2f, 2>(offA, offB);
}

fn sampleBounded(tex: texture_2d<f32>, uv: vec2f) -> vec4f {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4f(0.0);
  }
  // Explicit LOD sampling is valid in non-uniform control flow. The bounds
  // branch depends on per-fragment UVs, so implicit-derivative textureSample
  // is rejected by compatibility-mode WGSL validation.
  return textureSampleLevel(tex, samp, uv, 0.0);
}

fn smearAxis(dir: f32) -> vec2f {
  if (dir < 0.5) { return vec2f(1.0, 0.0); }
  if (dir < 1.5) { return vec2f(-1.0, 0.0); }
  if (dir < 2.5) { return vec2f(0.0, 1.0); }
  return vec2f(0.0, -1.0);
}

fn overPremul(a: vec4f, b: vec4f) -> vec4f {
  // B over A (both premultiplied or straight-as-premul from layer path)
  let outA = b.a + a.a * (1.0 - b.a);
  let outRgb = b.rgb + a.rgb * (1.0 - b.a);
  return vec4f(outRgb, outA);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let progress = clamp(uniforms.u.x, 0.0, 1.0);
  let kind = uniforms.u.y;
  let dir = uniforms.u.z;
  let soft = max(uniforms.u.w, 0.0001);
  let uv = input.uv;
  let blur = max(uniforms.v.z, uniforms.u.w);
  let aspect = max(uniforms.v.w, 0.0001);

  if (kind < 0.5) {
    // Wipe
    var coord = uv.x;
    if (dir < 0.5) { coord = uv.x; }
    else if (dir < 1.5) { coord = 1.0 - uv.x; }
    else if (dir < 2.5) { coord = uv.y; }
    else { coord = 1.0 - uv.y; }
    let edge = progress * (1.0 + 2.0 * soft) - soft;
    let t = smoothstep(edge - soft, edge + soft, coord);
    let a = textureSample(texA, samp, uv);
    let b = textureSample(texB, samp, uv);
    return mix(a, b, 1.0 - t);
  }

  if (kind >= 2.5 && kind < 3.5) {
    // Iris: circular in pixel space (aspect-correct UV)
    let cx = uniforms.v.x;
    let cy = uniforms.v.y;
    let p = (uv - vec2f(cx, cy)) * vec2f(aspect, 1.0);
    let corner = (vec2f(select(0.0, 1.0, cx < 0.5), select(0.0, 1.0, cy < 0.5)) - vec2f(cx, cy)) * vec2f(aspect, 1.0);
    let radius = max(length(corner), 0.001);
    let edge = progress * (1.0 + 2.0 * soft) - soft;
    let nd = length(p) / radius;
    let t = smoothstep(edge - soft, edge + soft, nd);
    let a = textureSample(texA, samp, uv);
    let b = textureSample(texB, samp, uv);
    return mix(b, a, t);
  }

  if (kind >= 3.5 && kind < 4.5) {
    // Zoom smash: outgoing zooms away while incoming resolves from overscale.
    let amount = max(uniforms.v.z, 0.1);
    let ua = (uv - vec2f(0.5)) * (1.0 + progress * amount * 1.5) + vec2f(0.5);
    let ub = (uv - vec2f(0.5)) * (1.0 + (1.0 - progress) * amount * 1.5) + vec2f(0.5);
    return mix(sampleBounded(texA, ua), sampleBounded(texB, ub), progress);
  }

  if (kind >= 4.5 && kind < 5.5) {
    // Spin: opposite rotations around center. dir left reverses the turn.
    let sign = select(1.0, -1.0, dir < 0.5);
    let turns = max(uniforms.v.z, 0.1) * 3.14159265;
    let ca = cos(sign * progress * turns);
    let sa = sin(sign * progress * turns);
    let cb = cos(-sign * (1.0 - progress) * turns);
    let sb = sin(-sign * (1.0 - progress) * turns);
    let p = uv - vec2f(0.5);
    let ua = vec2f(p.x * ca - p.y * sa, p.x * sa + p.y * ca) + vec2f(0.5);
    let ub = vec2f(p.x * cb - p.y * sb, p.x * sb + p.y * cb) + vec2f(0.5);
    return mix(sampleBounded(texA, ua), sampleBounded(texB, ub), progress);
  }

  if (kind >= 5.5 && kind < 6.5) {
    // Squeeze in the chosen axis before revealing B.
    let horizontal = dir < 1.5;
    let scaleA = max(0.001, 1.0 - progress);
    let scaleB = max(0.001, progress);
    var ua = uv;
    var ub = uv;
    if (horizontal) {
      ua.x = (uv.x - 0.5) / scaleA + 0.5;
      ub.x = (uv.x - 0.5) / scaleB + 0.5;
    } else {
      ua.y = (uv.y - 0.5) / scaleA + 0.5;
      ub.y = (uv.y - 0.5) / scaleB + 0.5;
    }
    return overPremul(sampleBounded(texA, ua), sampleBounded(texB, ub));
  }

  if (kind >= 6.5 && kind < 7.5) {
    // Diagonal peel edge with configurable softness.
    let diagonal = select(uv.x + uv.y, (1.0 - uv.x) + uv.y, dir < 1.5);
    let edge = progress * 2.0;
    let t = smoothstep(edge - soft, edge + soft, diagonal);
    return mix(textureSample(texB, samp, uv), textureSample(texA, samp, uv), t);
  }

  if (kind >= 7.5 && kind < 8.5) {
    let white = vec4f(1.0, 1.0, 1.0, 1.0);
    return select(mix(textureSample(texA, samp, uv), white, progress * 2.0), mix(white, textureSample(texB, samp, uv), (progress - 0.5) * 2.0), progress >= 0.5);
  }
  if (kind >= 8.5 && kind < 10.5) {
    let base = mix(textureSample(texA, samp, uv), textureSample(texB, samp, uv), progress);
    let flash = sin(progress * 3.14159265) * max(uniforms.v.z, 0.1);
    return mix(base, vec4f(1.0), flash);
  }
  if (kind >= 10.5 && kind < 11.5) {
    let amount = max(uniforms.v.z, 0.1);
    let row = floor(uv.y * 48.0);
    let jitter = (fract(sin(row * 91.17 + progress * 37.0) * 43758.5) - 0.5) * amount * 0.12;
    let a = sampleBounded(texA, uv + vec2f(jitter * progress, 0.0));
    let b = sampleBounded(texB, uv - vec2f(jitter * (1.0 - progress), 0.0));
    return mix(a, b, progress);
  }
  if (kind >= 11.5) {
    let base = mix(textureSample(texA, samp, uv), textureSample(texB, samp, uv), progress);
    let amount = max(uniforms.v.z, 0.1) * sin(progress * 3.14159265);
    let warm = select(vec3f(1.0, 0.35, 0.06), vec3f(1.0, 0.72, 0.26), kind >= 12.5);
    let radial = smoothstep(1.0, 0.0, length(uv - vec2f(0.25, 0.2)));
    return vec4f(clamp(base.rgb + warm * amount * radial, vec3f(0.0), vec3f(1.0)), base.a);
  }

  // Push (kind~1) or Whip (kind~2): slide + optional smear, premul over
  let offs = pushOffsets(progress, dir);
  let offA = offs[0];
  let offB = offs[1];
  let axis = smearAxis(dir);
  let smear = select(0.0, blur * 0.08, kind >= 1.5);
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  var wSum = 0.0;
  for (var i = -2; i <= 2; i++) {
    let fi = f32(i);
    let w = 1.0 - abs(fi) * 0.2;
    let delta = axis * (fi * smear);
    a += sampleBounded(texA, uv - offA + delta) * w;
    b += sampleBounded(texB, uv - offB + delta) * w;
    wSum += w;
  }
  a /= wSum;
  b /= wSum;
  return overPremul(a, b);
}
`;

/** Soft SDF rect/ellipse mask multiply on layer alpha. */
export const MASK_SHADER = /* wgsl */ `
struct Uniforms {
  // x,y,w,h in 0..1 clip UV
  bounds: vec4f,
  // x=feather, y=inverted (0/1), z=opacity, w=shape (0 rect, 1 ellipse)
  params: vec4f,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  var uv = array<vec2f, 3>(
    vec2f(0.0, 1.0),
    vec2f(2.0, 1.0),
    vec2f(0.0, -1.0)
  );
  var out: VertexOut;
  out.position = vec4f(pos[vi], 0.0, 1.0);
  out.uv = uv[vi];
  return out;
}

fn sdBox(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let c = textureSample(src, samp, input.uv);
  let bx = u.bounds.x;
  let by = u.bounds.y;
  let bw = max(u.bounds.z, 0.0001);
  let bh = max(u.bounds.w, 0.0001);
  let cx = bx + bw * 0.5;
  let cy = by + bh * 0.5;
  let feather = max(u.params.x, 0.0001);
  let inverted = u.params.y > 0.5;
  let mop = clamp(u.params.z, 0.0, 1.0);
  let isEllipse = u.params.w > 0.5;

  var inside = 0.0;
  if (isEllipse) {
    // feather is UV units; convert to ellipse radius-space
    let halfMin = min(bw, bh) * 0.5;
    let featherR = feather / max(halfMin, 0.0001);
    let p = (input.uv - vec2f(cx, cy)) / vec2f(bw * 0.5, bh * 0.5);
    let d = length(p) - 1.0;
    inside = 1.0 - smoothstep(-featherR, featherR, d);
  } else {
    let p = input.uv - vec2f(cx, cy);
    let d = sdBox(p, vec2f(bw * 0.5, bh * 0.5));
    inside = 1.0 - smoothstep(-feather, feather, d);
  }

  var m = inside;
  if (inverted) {
    m = 1.0 - m;
  }
  m *= mop;
  return vec4f(c.rgb * m, c.a * m);
}
`;

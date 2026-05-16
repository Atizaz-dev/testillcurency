/**
 * Garment mockup: mask → recolor via
 *   • **Catalog / pure-white product mode**: straight-α composite — `G = tint×luminance` (or base×tint for multiply)
 *     in linear sRGB, then `pixel = G·α + backdrop·(1−α)`; no premultiplied fringe, no post bleach (`applyStraightAlpha*`).
 *   • **LAB transfer** (mockup default): L* + texture + swatch chroma (`applyMaskedLabRecolor`).
 *   • **Linear multiply** (optional, mockup): `applyMaskedMultiplyRecolor`.
 *   • Legacy tint (`applyMaskedSolidFill`).
 * Optional artwork + studio finish compose on top of the masked garment.
 *
 * Mask pipeline (binary until full-res export):
 * 1. Edge flood → initial garment guess
 * 2. Merge significant connected components (torso + sleeves, not “largest only”)
 * 3. Fill only modest enclosed holes (hood nooks); skip holes that average to bright chroma-key green; caps stay below typical armpit–backdrop voids
 * 4. Morphological close / open — noise + gap handling
 * 5. Cull pixels more similar to border color than to eroded “core” fabric (tan halos, missed BG)
 * 6. Binary 3×3 majority — slight edge smoothing (still 0/1)
 * 6b. Cull garment pixels whose base RGB still reads as green- or red-screen spill (armpit wedges, halos)
 * 7. Light dilation — recover silhouette after opens
 * 8. Upscale with high-quality smoothing, then separable blur on mask alpha (AA band)
 * 9. Optional: drop tiny disconnected specks (hood / armpit junk) while keeping the main garment blob
 *
 * Tint: luminance-matched color, JPEG fringe neutralize (R/G spikes + saturation), texture mix, defringe.
 */

const AppAuth = window.AppAuth || {};
const authInit = AppAuth.initAuth || (async () => {});
const authHasActiveSubscription = AppAuth.hasActiveSubscription || (() => true);
const authRecordActivity = AppAuth.recordActivity || (async () => {});
const mirrorWorkFileToServer =
  typeof AppAuth.uploadWorkFileToServer === "function"
    ? (file, kind) => {
        void AppAuth.uploadWorkFileToServer(file, kind).catch(() => {});
      }
    : () => {};

/**
 * Finished auto+refined masks for bundled `default-base-*` samples only (instant thumb re-select).
 * User uploads and brush/refine still rebuild; not a server substitute.
 */
const defaultGarmentMaskCache = new Map();

function cloneMaskCanvas(src) {
  if (!src || !src.width) return null;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

function isBundledDefaultBaseEntry() {
  const id = state.activeBaseId;
  if (!id || !String(id).startsWith("default-base-")) return false;
  const entry = state.baseLibrary.find((e) => e.id === id);
  return !!(entry && !entry.file);
}

function bundledDefaultMaskCacheKey() {
  return [
    state.activeBaseId,
    state.baseNaturalW,
    state.baseNaturalH,
    state.maskTolerance,
    state.maskEdgeAdjust,
    state.maskExtraFeather,
  ].join("|");
}

function invalidateBundledDefaultMaskCacheForId(baseId) {
  if (!baseId || !defaultGarmentMaskCache.size) return;
  const prefix = `${baseId}|`;
  for (const k of [...defaultGarmentMaskCache.keys()]) {
    if (k.startsWith(prefix)) defaultGarmentMaskCache.delete(k);
  }
}

function clearBundledDefaultMaskCache() {
  defaultGarmentMaskCache.clear();
}

function tryRestoreBundledDefaultMaskFromCache() {
  if (!isBundledDefaultBaseEntry() || !state.baseImg) return false;
  const key = bundledDefaultMaskCacheKey();
  const snap = defaultGarmentMaskCache.get(key);
  if (!snap || !snap.garment || !snap.auto) return false;
  if (snap.garment.width !== state.baseNaturalW || snap.garment.height !== state.baseNaturalH) return false;
  clearMaskPaintLayers();
  state.garmentMaskCanvas = cloneMaskCanvas(snap.garment);
  state.maskAutoCanvas = cloneMaskCanvas(snap.auto);
  state.alphaCutoutGarmentMask = !!snap.alphaCutout;
  state.maskHighKeyStudio = !!snap.maskHighKeyStudio;
  state.maskGeneration = snap.maskGeneration | 0;
  state.externalMaskActive = !!snap.externalMaskActive;
  return true;
}

function saveBundledDefaultMaskToCache() {
  if (!isBundledDefaultBaseEntry()) return;
  if (!state.garmentMaskCanvas || !state.maskAutoCanvas) return;
  const key = bundledDefaultMaskCacheKey();
  invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
  defaultGarmentMaskCache.set(key, {
    garment: cloneMaskCanvas(state.garmentMaskCanvas),
    auto: cloneMaskCanvas(state.maskAutoCanvas),
    alphaCutout: !!state.alphaCutoutGarmentMask,
    maskHighKeyStudio: !!state.maskHighKeyStudio,
    maskGeneration: state.maskGeneration | 0,
    externalMaskActive: !!state.externalMaskActive,
  });
}

const JSZip = globalThis.JSZip;

/** Max dimension when building mask (scaled up to full export size). 3200 balances speed vs edge quality on large flat-lays. */
const MASK_BUILD_MAX = 3200;

/** External mask PNG (rembg etc.): morphology on a downscaled grid (fast at full photo resolution). */
const EXT_MASK_REFINE_MAX = 1400;

/** Default export swatch strip (left → right); “Defaults” resets to this list. */
/** Bundled garment samples: gallery always starts with these three (paths relative to `index.html`). */
const DEFAULT_BASE_GALLERY = [
  { path: "test-assets/Shirts_T/45.png", name: "Sample shirt 1" },
  { path: "test-assets/Shirts_T/46.png", name: "Sample shirt 2" },
  { path: "test-assets/Shirts_T/47.png", name: "Sample shirt 3" },
];

/** Core catalog colors + legacy presets (hexes are mockup-friendly approximations). */
const PRESET_COLORS = [
  { name: "Black", hex: "#1a1a1a" },
  { name: "White", hex: "#ffffff" },
  { name: "Light Blue", hex: "#9dc3e6" },
  { name: "Navy", hex: "#1b2845" },
  { name: "Royal Blue", hex: "#2248b4" },
  { name: "Forest Green", hex: "#2d4a32" },
  { name: "Red", hex: "#d62828" },
  { name: "Azalea", hex: "#e8799e" },
  { name: "Daisy", hex: "#fdeaa7" },
  { name: "Sand", hex: "#d4c4a8" },
  { name: "Sport Grey", hex: "#8d9095" },
  { name: "Charcoal", hex: "#3d4449" },
  { name: "Dark Chocolate", hex: "#3d2914" },
  { name: "Purple", hex: "#5b21b6" },
  { name: "Kelly Green", hex: "#047857" },
  { name: "Orange", hex: "#ea580c" },
  { name: "Maroon", hex: "#6b1c2e" },
  { name: "Golden Yellow", hex: "#f7c554" },
  { name: "Bottle Green", hex: "#3d6b4a" },
  { name: "Tan", hex: "#9a6b3f" },
  { name: "Khaki", hex: "#c4b896" },
  { name: "Light Pink", hex: "#f5b8c8" },
  { name: "Silver", hex: "#b5b8bc" },
];

const EXPORT_COLORS_STORAGE_KEY = "us_clothing_export_colors_v1";
const EXPORT_ROOT_NAME_STORAGE_KEY = "us_clothing_export_root_name_v1";
const EXPORT_SKU_STORAGE_KEY = "us_clothing_export_sku_v1";
/** Safe top-level folder / ZIP base when the user leaves the export name blank. */
const DEFAULT_EXPORT_ROOT = "mockup-export";
/** Luminance split for light vs dark swatch groups (same threshold as the swatch is-dark style). */
const SWATCH_LIGHT_DARK_SPLIT = 0.45;

/** Browser-generated mockup downloads (WebP — smaller than PNG; not JPEG). */
const EXPORT_MOCKUP_MIME = "image/webp";
const EXPORT_MOCKUP_EXT = "webp";
const EXPORT_MOCKUP_QUALITY = 0.92;

const state = {
  baseImg: null,
  baseNaturalW: 0,
  baseNaturalH: 0,
  designLightImg: null,
  designDarkImg: null,
  /** When false, preview draws no design; export still uses uploaded artwork per garment color. */
  designOverlayVisible: true,
  designNx: 0.5,
  designNy: 0.38,
  designScalePct: 35,
  designRotDeg: 0,
  dragging: false,
  dragLast: { x: 0, y: 0 },
  colors: [],
  /** When true, export swatches render in separate light / dark rows by luminance. */
  groupSwatchesByLuma: true,
  generated: [],
  exportFolderName: "mockup-export",
  /** After Shopify CSV apply: override subfolder + per-color file bases (Variant SKU). */
  shopifyCsvNaming: null,
  /** Parsed CSV `{ headers, records }` from last successful file read. */
  shopifyCsvParsed: null,
  usingDefaultBase: false,
  treeObjectUrls: [],
  /** Preview: `original` | `neutral` | `recolor` (export always uses full recolor). */
  previewMode: "recolor",
  focusColorId: "p-0",
  /** 8–85, higher = more aggressive “backdrop” flood from edges. */
  maskTolerance: 34,
  /** 0–0.55, blend original photo back into tinted garment for fabric grain / variation. */
  texturePreserve: 0.4,
  /** 0–1, pull semi-transparent mask edges toward target swatch (kills colored halos). */
  defringeStrength: 0.82,
  /** 0–1, modulate design by garment luminance (folds & lighting on the print). */
  designFabricBlend: 0.38,
  /** Gaussian blur on artwork (px) when fabric blend is active. */
  designPrintBlurPx: 0.22,
  /** Full-res mask alpha (soft edges after upscale). Same size as base natural. */
  garmentMaskCanvas: null,
  /** Auto cutout only; `syncRefinedGarmentMask` builds `garmentMaskCanvas` from this + sliders + brush. */
  maskAutoCanvas: null,
  /** Full-res: brush adds garment alpha (white in alpha channel). */
  maskPaintAdd: null,
  /** Full-res: brush subtracts garment alpha. */
  maskPaintSub: null,
  /** −10…10 negative = shrink selection, positive = grow (morphology on mask alpha). */
  maskEdgeAdjust: 0,
  /** 0–3 extra feather passes after refine. */
  maskExtraFeather: 0,
  /** `off` | `add` | `remove` — paint on preview to include/exclude areas (model shots, prints, hair). */
  maskBrushMode: "off",
  maskBrushSizeNat: 42,
  maskPainting: false,
  designScratchCanvas: null,
  /** When true, mask came from rembg (or any external PNG alpha); built-in flood cutout is skipped until refresh. */
  externalMaskActive: false,
  /** Last auto mask: bright low-chroma border (white studio) — softer shadow edges + recolor fringe tuned for drop shadows. */
  maskHighKeyStudio: false,
  /**
   * Auto mask was seeded from PNG alpha (transparent border) or rembg — matting often leaves dark RGB on
   * partial alpha; tint/fringe math must not treat that as deep fabric.
   */
  alphaCutoutGarmentMask: false,
  /** Grounding shadow under transparent PNG cutouts (and hem shadow on JPEG flat-lays). */
  contactShadowEnabled: true,
  /** 0.06–0.30, peak opacity of blurred silhouette shadow. */
  contactShadowOpacity: 0.17,
  /** Top key light, collar depth, cotton micro-texture, mild asymmetry — mask-clipped for clean ecommerce edges. */
  studioPhotorealFinish: true,
  /**
   * When true: grayscale-neutral analysis + LAB chroma from swatch + separate achromatic shadow multiply +
   * neutral texture overlay (mathematically stable vs colored PNG multiply).
   */
  labRecolorPipeline: true,
  /**
   * When true (and LAB path would run): recolor with linear sRGB multiply on the original photo pixels inside
   * the mask — preserves texture and lighting 1:1 like dye on a white/light shirt; use a muted swatch for natural mustard.
   */
  multiplyTintRecolor: false,
  /** Bumps when mask is rebuilt/refined — invalidates LAB decomposition cache. */
  maskGeneration: 0,
  /** @type {{ key: string, w: number, h: number, n: number, Lstar: Float32Array, mult: Float32Array, tex: Float32Array, alphaRaw: Uint8Array, neutralRgba: Uint8ClampedArray, Ylin: Float32Array, maskEdgeGrad: Uint8Array, neutralMaxNeighL: Float32Array, alphaNeighborMax: Uint8Array } | null} */
  recolorDecomp: null,
  /**
   * Final catalog output: exact #FFFFFF, no contact/studio shadows, no canvas edge strips, tighter fringe
   * (overrides scene picker for fill + decontam target).
   */
  pureWhiteProductMode: true,
  /** `{ id, file, url }` — `url` is object URL; max ~10 entries this session. */
  baseLibrary: [],
  activeBaseId: null,
  designLightFileName: "",
  designDarkFileName: "",
  /** Fingerprint of last cached preview layer (garment only, no design) for fast drag. */
  garmentPreviewCacheFp: "",
};

const els = {
  baseFile: document.getElementById("baseFile"),
  baseGallery: document.getElementById("baseGallery"),
  designLightFile: document.getElementById("designLightFile"),
  designDarkFile: document.getElementById("designDarkFile"),
  sceneBg: document.getElementById("sceneBg"),
  contactShadowEnable: document.getElementById("contactShadowEnable"),
  contactShadowOpacity: document.getElementById("contactShadowOpacity"),
  contactShadowOpacityVal: document.getElementById("contactShadowOpacityVal"),
  studioPhotorealFinish: document.getElementById("studioPhotorealFinish"),
  pureWhiteProductMode: document.getElementById("pureWhiteProductMode"),
  backdropInactiveHint: document.getElementById("backdropInactiveHint"),
  groupExportSwatches: document.getElementById("groupExportSwatches"),
  colorSwatchRow: document.getElementById("colorSwatchRow"),
  colorNameDisplay: document.getElementById("colorNameDisplay"),
  selectAllColors: document.getElementById("selectAllColors"),
  deselectAllColors: document.getElementById("deselectAllColors"),
  customColor: document.getElementById("customColor"),
  customColorHex: document.getElementById("customColorHex"),
  customColorName: document.getElementById("customColorName"),
  addCustomColor: document.getElementById("addCustomColor"),
  resetDefaultColors: document.getElementById("resetDefaultColors"),
  exportRootName: document.getElementById("exportRootName"),
  exportSku: document.getElementById("exportSku"),
  shopifyCsvFile: document.getElementById("shopifyCsvFile"),
  shopifyCsvControls: document.getElementById("shopifyCsvControls"),
  shopifyCsvProduct: document.getElementById("shopifyCsvProduct"),
  shopifyCsvApply: document.getElementById("shopifyCsvApply"),
  shopifyCsvClear: document.getElementById("shopifyCsvClear"),
  shopifyCsvPreview: document.getElementById("shopifyCsvPreview"),
  generateBtn: document.getElementById("generateBtn"),
  downloadZipBtn: document.getElementById("downloadZipBtn"),
  status: document.getElementById("status"),
  appLoader: document.getElementById("appLoader"),
  previewBusyOverlay: document.getElementById("previewBusyOverlay"),
  previewBusyLabel: document.getElementById("previewBusyLabel"),
  previewCanvas: document.getElementById("previewCanvas"),
  designScale: document.getElementById("designScale"),
  designRot: document.getElementById("designRot"),
  scaleVal: document.getElementById("scaleVal"),
  rotVal: document.getElementById("rotVal"),
  folderTree: document.getElementById("folderTree"),
  maskTolerance: document.getElementById("maskTolerance"),
  texturePreserve: document.getElementById("texturePreserve"),
  texturePreserveVal: document.getElementById("texturePreserveVal"),
  defringeStrength: document.getElementById("defringeStrength"),
  defringeStrengthVal: document.getElementById("defringeStrengthVal"),
  multiplyTintRecolor: document.getElementById("multiplyTintRecolor"),
  rebuildMaskBtn: document.getElementById("rebuildMaskBtn"),
  designFabricBlend: document.getElementById("designFabricBlend"),
  designFabricBlendVal: document.getElementById("designFabricBlendVal"),
  maskEdgeAdjust: document.getElementById("maskEdgeAdjust"),
  maskEdgeAdjustVal: document.getElementById("maskEdgeAdjustVal"),
  maskExtraFeather: document.getElementById("maskExtraFeather"),
  maskExtraFeatherVal: document.getElementById("maskExtraFeatherVal"),
  maskBrushMode: document.getElementById("maskBrushMode"),
  maskBrushSize: document.getElementById("maskBrushSize"),
  maskBrushSizeVal: document.getElementById("maskBrushSizeVal"),
  clearMaskPaintBtn: document.getElementById("clearMaskPaintBtn"),
  resetMaskRefineBtn: document.getElementById("resetMaskRefineBtn"),
  maskPaintOverlay: document.getElementById("maskPaintOverlay"),
  rembgMaskFile: document.getElementById("rembgMaskFile"),
  clearRembgMaskBtn: document.getElementById("clearRembgMaskBtn"),
  removeBaseBtn: document.getElementById("removeBaseBtn"),
  removeDesignLightBtn: document.getElementById("removeDesignLightBtn"),
  removeDesignDarkBtn: document.getElementById("removeDesignDarkBtn"),
  designLightMeta: document.getElementById("designLightMeta"),
  designDarkMeta: document.getElementById("designDarkMeta"),
  designShowOnPreview: document.getElementById("designShowOnPreview"),
  previewDesignActions: document.getElementById("previewDesignActions"),
  toggleDesignOverlayBtn: document.getElementById("toggleDesignOverlayBtn"),
  removeAllDesignsBtn: document.getElementById("removeAllDesignsBtn"),
};

const previewCtx = els.previewCanvas.getContext("2d", { alpha: true });

function setStatus(msg, kind = "") {
  if (!els.status) return;
  els.status.textContent = msg;
  els.status.className = "status" + (kind ? ` ${kind}` : "");
}

/**
 * @param {boolean} active
 * @param {{ overlay?: boolean; label?: string }} [opts]
 */
function setAppLoading(active, opts = {}) {
  const { overlay = false, label = "" } = opts;
  if (els.appLoader) {
    els.appLoader.classList.toggle("is-visible", !!active);
  }
  if (els.previewBusyOverlay) {
    const showOverlay = !!active && !!overlay;
    els.previewBusyOverlay.hidden = !showOverlay;
    els.previewBusyOverlay.setAttribute("aria-hidden", showOverlay ? "false" : "true");
  }
  if (els.previewBusyLabel) {
    if (active && label) els.previewBusyLabel.textContent = label;
    else if (active && overlay) els.previewBusyLabel.textContent = "Working…";
  }
}

function setPreviewBusyProgress(text) {
  if (els.previewBusyLabel && text) els.previewBusyLabel.textContent = text;
}

function syncTextureDefringeLabels() {
  if (els.texturePreserveVal) {
    els.texturePreserveVal.textContent = `${Math.round(state.texturePreserve * 100)}%`;
  }
  if (els.defringeStrengthVal) {
    els.defringeStrengthVal.textContent = `${Math.round(state.defringeStrength * 100)}%`;
  }
  if (els.designFabricBlendVal) {
    els.designFabricBlendVal.textContent = `${Math.round(state.designFabricBlend * 100)}%`;
  }
}

function rgbDist2(data, i, er, eg, eb) {
  const p = i * 4;
  const dr = data[p] - er;
  const dg = data[p + 1] - eg;
  const db = data[p + 2] - eb;
  return dr * dr + dg * dg + db * db;
}

/**
 * Detect white-cyclorama / high-key product shots: bright, even, low-chroma borders. Soft drop shadows
 * then carry the only garment outline — boost edge math so the flood does not leak through the ramp.
 */
function analyzeBorderHighKeyStudio(data, w, h) {
  let sumL = 0;
  let sumL2 = 0;
  let sumCh = 0;
  let cnt = 0;
  const sample = (i) => {
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const L = luminanceRgb(r, g, b);
    sumL += L;
    sumL2 += L * L;
    sumCh += Math.max(r, g, b) - Math.min(r, g, b);
    cnt++;
  };
  for (let x = 0; x < w; x++) {
    sample(x);
    sample((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    sample(y * w);
    sample(y * w + (w - 1));
  }
  if (cnt < 8) {
    return { highKey: false, borderMeanL: 0, borderStdL: 0, borderMeanChroma: 0 };
  }
  const borderMeanL = sumL / cnt;
  const borderVar = Math.max(0, sumL2 / cnt - borderMeanL * borderMeanL);
  const borderStdL = Math.sqrt(borderVar);
  const borderMeanChroma = sumCh / cnt;
  const highKey =
    borderMeanL > 235.2 &&
    borderStdL < 19.5 &&
    borderMeanChroma < 26;
  return { highKey, borderMeanL, borderStdL, borderMeanChroma };
}

/**
 * Catalog PNGs with transparent exterior (e.g. cutouts on checkerboard): border alpha is near 0 while the
 * product interior is opaque. Edge flood + “green screen” spill culls mis-fire on mint/sage fabric and on alpha edges.
 */
function detectLikelyPngAlphaCutout(data, w, h) {
  let sumA = 0;
  let cnt = 0;
  for (let x = 0; x < w; x++) {
    sumA += data[x * 4 + 3] + data[((h - 1) * w + x) * 4 + 3];
    cnt += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    sumA += data[(y * w) * 4 + 3] + data[(y * w + (w - 1)) * 4 + 3];
    cnt += 2;
  }
  const borderMeanA = sumA / cnt;
  if (borderMeanA > 52) return false;
  const n = w * h;
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] >= 200) opaque++;
  }
  return opaque / n > 0.045;
}

/** Flood from edges: pixels similar to mean edge color become background (1). */
function floodEdgeBackground(data, w, h, tolerance) {
  const d = data;
  let er = 0;
  let eg = 0;
  let eb = 0;
  let ec = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = (y * w + x) * 4;
      er += d[p];
      eg += d[p + 1];
      eb += d[p + 2];
      ec++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      const p = (y * w + x) * 4;
      er += d[p];
      eg += d[p + 1];
      eb += d[p + 2];
      ec++;
    }
  }
  er /= ec;
  eg /= ec;
  eb /= ec;

  const thr = tolerance * tolerance * 14;
  const isBg = new Uint8Array(w * h);
  const stack = [];

  const tryPush = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = y * w + x;
    if (isBg[i]) return;
    if (rgbDist2(d, i, er, eg, eb) > thr) return;
    isBg[i] = 1;
    stack.push(x, y);
  };

  for (let x = 0; x < w; x++) {
    tryPush(x, 0);
    tryPush(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y);
    tryPush(w - 1, y);
  }

  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    tryPush(x + 1, y);
    tryPush(x - 1, y);
    tryPush(x, y + 1);
    tryPush(x, y - 1);
  }

  return isBg;
}

function dilateBinary(g, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (g[i]) {
        out[i] = 1;
        continue;
      }
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h && g[ny * w + nx]) {
            v = 1;
            break;
          }
        }
      }
      out[i] = v;
    }
  }
  return out;
}

function erodeBinary(g, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!g[i]) {
        out[i] = 0;
        continue;
      }
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || !g[ny * w + nx]) {
            ok = 0;
            break;
          }
        }
      }
      out[i] = ok;
    }
  }
  return out;
}

function morphCloseBinary(g, w, h, passes) {
  let a = g;
  for (let p = 0; p < passes; p++) a = dilateBinary(a, w, h);
  for (let p = 0; p < passes; p++) a = erodeBinary(a, w, h);
  return a;
}

/** Erode then dilate — removes small isolated foreground specks, trims thin prongs. */
function morphOpenBinary(g, w, h, passes) {
  let a = g;
  for (let p = 0; p < passes; p++) a = erodeBinary(a, w, h);
  for (let p = 0; p < passes; p++) a = dilateBinary(a, w, h);
  return a;
}

function dilateBinaryTimes(g, w, h, times) {
  let a = g;
  for (let t = 0; t < times; t++) a = dilateBinary(a, w, h);
  return a;
}

function erodeBinaryTimes(g, w, h, times) {
  let a = g;
  for (let t = 0; t < times; t++) a = erodeBinary(a, w, h);
  return a;
}

/**
 * Per-pixel: lime / chroma-green screen (spill, halos, armpit wedges). Pastel mint/sage products keep
 * meaningful R/B — require weak red/blue like real keying, not “G wins on a bright shirt”.
 */
function baseRgbLooksLikeGreenChromaKey(r, g, b) {
  const maxRB = Math.max(r, b);
  const minRB = Math.min(r, b);
  const L = luminanceRgb(r, g, b);
  if (g < maxRB + 26) return false;
  const chroma = Math.max(r, g, b) - minRB;
  if (g > 190 && maxRB < 72 && g > maxRB + 48) return true;
  if (g > 178 && maxRB < 52 && g > maxRB + 55 && L > 78) return true;
  if (
    chroma > 102 &&
    g >= Math.max(r, b) &&
    g > maxRB + 52 &&
    L > 92 &&
    maxRB < 88
  ) {
    return true;
  }
  return false;
}

/**
 * Hot scarlet / pink-red matting & red-screen spill — not deep maroon / burgundy garment body (#6b1c2e, etc.).
 */
function baseRgbLooksLikeRedChromaKey(r, g, b) {
  const maxGB = Math.max(g, b);
  const minGB = Math.min(g, b);
  const L = luminanceRgb(r, g, b);
  if (r < maxGB + 22) return false;
  const chroma = Math.max(r, g, b) - minGB;
  /** Hot key / matting: R high, G and B stay relatively low (avoid multi-color prints). */
  if (r > 188 && maxGB < 108 && r > maxGB + 44) return true;
  if (r > 162 && maxGB < 92 && r > maxGB + 36 && L > 82) return true;
  if (minGB < 96 && L > 156 && r > maxGB + 34 && r > 132) return true;
  if (
    minGB < 100 &&
    chroma > 82 &&
    r >= Math.max(g, b) &&
    r > maxGB + 44 &&
    L > 85
  ) {
    return true;
  }
  return false;
}

/**
 * True when mean RGB of a mask “hole” looks like bright chroma-key green (not forest garment fabric).
 * Stops hole-fill from sealing armpit wedges that still show the green screen.
 */
function rgbLooksLikeBrightGreenScreenKey(r, g, b) {
  if (baseRgbLooksLikeGreenChromaKey(r, g, b)) return true;
  const maxRB = Math.max(r, b);
  const L = luminanceRgb(r, g, b);
  if (g < maxRB + 22) return false;
  if (L < 72) return false;
  /** Skip hole-fill for screen-colored voids only when R/B stay low like keying — not mint catalog greens. */
  if (maxRB > 92) return false;
  if (L > 105 && g > maxRB + 28) return true;
  if (g > 145 && g > maxRB + 35) return true;
  return false;
}

/**
 * Hole-fill skip: mean color reads as red/pink screen or hot matting, not deep garment red.
 */
function rgbLooksLikeBrightRedScreenKey(r, g, b) {
  if (baseRgbLooksLikeRedChromaKey(r, g, b)) return true;
  const maxGB = Math.max(g, b);
  const L = luminanceRgb(r, g, b);
  if (r < maxGB + 18) return false;
  if (L < 68) return false;
  if (L > 100 && r > maxGB + 26) return true;
  if (r > 138 && r > maxGB + 30) return true;
  return false;
}

/**
 * Drop garment=1 where the base photo is still chroma-key green (fixes filled armpits + rim garbage).
 */
function cullGreenChromaKeySpillFromBinaryGarment(garment, baseRgba, w, h) {
  const n = w * h;
  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    if (!garment[i]) continue;
    const o = i * 4;
    if (
      baseRgbLooksLikeGreenChromaKey(
        baseRgba[o],
        baseRgba[o + 1],
        baseRgba[o + 2]
      )
    ) {
      out[i] = 0;
    }
  }
  return out;
}

function cullRedChromaKeySpillFromBinaryGarment(garment, baseRgba, w, h) {
  const n = w * h;
  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    if (!garment[i]) continue;
    const o = i * 4;
    if (
      baseRgbLooksLikeRedChromaKey(
        baseRgba[o],
        baseRgba[o + 1],
        baseRgba[o + 2]
      )
    ) {
      out[i] = 0;
    }
  }
  return out;
}

/** Green- or red-screen spill still keyed as garment after AI / hole-fill. */
function cullChromaKeySpillFromBinaryGarment(garment, baseRgba, w, h) {
  let g = cullGreenChromaKeySpillFromBinaryGarment(garment, baseRgba, w, h);
  return cullRedChromaKeySpillFromBinaryGarment(g, baseRgba, w, h);
}

/**
 * Flood exterior non-garment from borders. Interior voids are pixels with garment=0 and outside=0.
 * Fill only void components with area ≤ maxArea so real armpit / sleeve gaps (large) stay backdrop.
 * Optional baseRgba: skip filling holes whose mean color reads as green- or red-screen (avoids wedge blocks).
 */
function fillSmallEnclosedHoles(garment, w, h, maxArea, baseRgba) {
  const n = w * h;
  const outside = new Uint8Array(n);
  const stack = [];
  const pushNonGarment = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = y * w + x;
    if (garment[i]) return;
    if (outside[i]) return;
    outside[i] = 1;
    stack.push(x, y);
  };
  for (let x = 0; x < w; x++) {
    pushNonGarment(x, 0);
    pushNonGarment(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    pushNonGarment(0, y);
    pushNonGarment(w - 1, y);
  }
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    pushNonGarment(x + 1, y);
    pushNonGarment(x - 1, y);
    pushNonGarment(x, y + 1);
    pushNonGarment(x, y - 1);
  }

  const label = new Int32Array(n).fill(-1);
  const compSizes = [];
  const trackHoleColor = !!baseRgba;
  const compSumR = trackHoleColor ? [] : null;
  const compSumG = trackHoleColor ? [] : null;
  const compSumB = trackHoleColor ? [] : null;
  const compCnt = trackHoleColor ? [] : null;
  let L = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (garment[i] || outside[i] || label[i] >= 0) continue;
      const myL = L++;
      if (trackHoleColor) {
        compSumR.push(0);
        compSumG.push(0);
        compSumB.push(0);
        compCnt.push(0);
      }
      const q = [x, y];
      label[i] = myL;
      let sz = 0;
      while (q.length) {
        const cy = q.pop();
        const cx = q.pop();
        sz++;
        if (trackHoleColor) {
          const pi = (cy * w + cx) * 4;
          compSumR[myL] += baseRgba[pi];
          compSumG[myL] += baseRgba[pi + 1];
          compSumB[myL] += baseRgba[pi + 2];
          compCnt[myL]++;
        }
        const neigh = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (garment[ni] || outside[ni] || label[ni] >= 0) continue;
          label[ni] = myL;
          q.push(nx, ny);
        }
      }
      compSizes.push(sz);
    }
  }

  const skipLabel = trackHoleColor ? new Uint8Array(L) : null;
  if (trackHoleColor) {
    for (let lid = 0; lid < L; lid++) {
      const c = compCnt[lid];
      if (c < 1) continue;
      const ar = compSumR[lid] / c;
      const ag = compSumG[lid] / c;
      const ab = compSumB[lid] / c;
      if (
        rgbLooksLikeBrightGreenScreenKey(ar, ag, ab) ||
        rgbLooksLikeBrightRedScreenKey(ar, ag, ab)
      ) {
        skipLabel[lid] = 1;
      }
    }
  }

  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue;
    const lid = label[i];
    if (!garment[i] && !outside[i] && compSizes[lid] <= maxArea) {
      if (skipLabel && skipLabel[lid]) continue;
      out[i] = 1;
    }
  }
  return out;
}

/**
 * Remove mask pixels that read like backdrop (mean border color) rather than fabric (eroded core).
 * Helps tan halos, leftover keying blocks, and chroma fringe attached to the silhouette.
 */
function cullBackdropFringeFromMask(garment, data, w, h) {
  const n = w * h;
  let er = 0;
  let eg = 0;
  let eb = 0;
  let ec = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  er /= ec;
  eg /= ec;
  eb /= ec;
  const edgeL = luminanceRgb(er, eg, eb);

  const erodePasses = Math.max(3, Math.min(7, Math.round(Math.min(w, h) / 200)));
  const coreMask = erodeBinaryTimes(garment, w, h, erodePasses);
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cc = 0;
  for (let i = 0; i < n; i++) {
    if (!coreMask[i]) continue;
    const p = i * 4;
    cr += data[p];
    cg += data[p + 1];
    cb += data[p + 2];
    cc++;
  }
  if (cc < 80) return garment;
  cr /= cc;
  cg /= cc;
  cb /= cc;
  const coreL = luminanceRgb(cr, cg, cb);
  if (edgeL <= coreL + 18) return garment;

  const out = new Uint8Array(garment);
  const ratio = 0.8;
  for (let i = 0; i < n; i++) {
    if (!garment[i]) continue;
    const x = i % w;
    const y = Math.floor(i / w);
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const Lp = luminanceRgb(data[p], data[p + 1], data[p + 2]);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    let nearCount = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= w) continue;
        if (garment[ny * w + nx]) nearCount++;
      }
    }
    const brightNeutralHighlight =
      Lp > coreL + 16 && chroma < 28 && nearCount >= 6;
    /** Pockets / ribbing / deep shade: don’t punch holes chasing backdrop similarity. */
    if (Lp < coreL + 8 && coreL > 35) continue;
    const ed = rgbDist2(data, i, er, eg, eb);
    const cd = rgbDist2(data, i, cr, cg, cb);
    if (cd < 400) continue;
    if (ed < cd * ratio) {
      /** Preserve interior shoulder highlights/light-gray folds that are surrounded by garment pixels. */
      if (brightNeutralHighlight) continue;
      out[i] = 0;
    }
    else {
      /** Matting residue: much brighter than fabric core but still keyed as garment (tan/white rim on dark hoodies). */
      if (Lp > coreL + 38 && ed < cd * 0.9) {
        if (brightNeutralHighlight) continue;
        out[i] = 0;
      }
    }
  }
  return out;
}

/**
 * Red/maroon garment on red backdrop: luminance cull often skips (edgeL ≈ coreL) but matting is still
 * saturated scarlet vs deeper fabric. Drop garment pixels that read like the red key, not the hoodie.
 */
function cullRedMattingFringe(garment, data, w, h) {
  const n = w * h;
  let er = 0;
  let eg = 0;
  let eb = 0;
  let ec = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  er /= ec;
  eg /= ec;
  eb /= ec;
  if (!(er > eg + 20 && er > eb + 20)) return garment;

  const erodePasses = Math.max(3, Math.min(7, Math.round(Math.min(w, h) / 200)));
  const coreMask = erodeBinaryTimes(garment, w, h, erodePasses);
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cc = 0;
  for (let i = 0; i < n; i++) {
    if (!coreMask[i]) continue;
    const p = i * 4;
    cr += data[p];
    cg += data[p + 1];
    cb += data[p + 2];
    cc++;
  }
  if (cc < 80) return garment;
  cr /= cc;
  cg /= cc;
  cb /= cc;
  const Lc = luminanceRgb(cr, cg, cb);

  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    if (!garment[i]) continue;
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const Lp = luminanceRgb(r, g, b);
    /** Folds / hood interior — never strip as “red key” matting. */
    if (Lp < 52) continue;
    const ed = rgbDist2(data, i, er, eg, eb);
    const cd = rgbDist2(data, i, cr, cg, cb);
    const maxGB = Math.max(g, b);
    if (r > cr + 16 && ed < cd * 0.76 && Lp >= Lc - 14) out[i] = 0;
    else if (
      r > 148 &&
      r > maxGB + 36 &&
      Lp > Lc + 4 &&
      ed < cd * 0.88
    ) {
      out[i] = 0;
    }
  }
  return out;
}

/**
 * Green-screen / lime backdrop: matting leaves neon G vs deeper garment. Drop pixels that read like the key, not fabric.
 * Mirrors cullRedMattingFringe; only runs when border mean is clearly green-dominant.
 */
function cullGreenMattingFringe(garment, data, w, h) {
  const n = w * h;
  let er = 0;
  let eg = 0;
  let eb = 0;
  let ec = 0;
  for (let x = 0; x < w; x++) {
    for (const y of [0, h - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (const x of [0, w - 1]) {
      const p = (y * w + x) * 4;
      er += data[p];
      eg += data[p + 1];
      eb += data[p + 2];
      ec++;
    }
  }
  er /= ec;
  eg /= ec;
  eb /= ec;
  if (!(eg > er + 20 && eg > eb + 20)) return garment;

  const erodePasses = Math.max(3, Math.min(7, Math.round(Math.min(w, h) / 200)));
  const coreMask = erodeBinaryTimes(garment, w, h, erodePasses);
  let cr = 0;
  let cg = 0;
  let cb = 0;
  let cc = 0;
  for (let i = 0; i < n; i++) {
    if (!coreMask[i]) continue;
    const p = i * 4;
    cr += data[p];
    cg += data[p + 1];
    cb += data[p + 2];
    cc++;
  }
  if (cc < 80) return garment;
  cr /= cc;
  cg /= cc;
  cb /= cc;
  const Lc = luminanceRgb(cr, cg, cb);

  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    if (!garment[i]) continue;
    const p = i * 4;
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const Lp = luminanceRgb(r, g, b);
    if (Lp < 52) continue;
    const ed = rgbDist2(data, i, er, eg, eb);
    const cd = rgbDist2(data, i, cr, cg, cb);
    const maxRB = Math.max(r, b);
    if (g > cg + 16 && ed < cd * 0.76 && Lp >= Lc - 14) out[i] = 0;
    else if (
      g > 148 &&
      g > maxRB + 36 &&
      Lp > Lc + 4 &&
      ed < cd * 0.88
    ) {
      out[i] = 0;
    }
  }
  return out;
}

/** 3×3 majority vote — jagged binary boundary becomes slightly smoother; output stays 0/1 only. */
function binaryMajoritySmooth(g, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          sum += g[ny * w + nx];
        }
      }
      out[y * w + x] = sum >= 5 ? 1 : 0;
    }
  }
  return out;
}

function toStrictBinary01(g, w, h) {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = g[i] ? 1 : 0;
  return out;
}

/**
 * Convert a binary garment mask into soft alpha using local coverage.
 * Interior stays opaque; contour gets sub-pixel alpha from a 5x5 neighborhood.
 */
function binaryMaskToSoftRgba(garment, w, h) {
  const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;
      const g = garment[i] ? 1 : 0;
      let alpha = 0;
      if (g) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            sum += garment[ny * w + nx] ? 1 : 0;
            cnt++;
          }
        }
        const cov = cnt > 0 ? sum / cnt : 0;
        alpha = Math.round(255 * Math.max(0, Math.min(1, cov)));
        if (alpha > 247) alpha = 255;
        if (alpha < 12) alpha = 0;
      } else {
        let near = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            if (garment[ny * w + nx]) near++;
          }
        }
        if (near > 0) alpha = Math.round((near / 9) * 95);
      }
      rgba[o] = 255;
      rgba[o + 1] = 255;
      rgba[o + 2] = 255;
      rgba[o + 3] = alpha;
    }
  }
  return rgba;
}

/**
 * Edge-blocked flood often splits one garment into torso vs sleeves. Keeping only the
 * largest CC colors a single sleeve; we union every blob that is a sizable fraction of
 * the biggest blob (and above a small image-area floor to drop speckle).
 */
function mergeSignificantGarmentComponents(garment, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  let L = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!garment[i] || label[i] >= 0) continue;
      const stack = [];
      stack.push(x, y);
      label[i] = L;
      let sz = 0;
      while (stack.length) {
        const cy = stack.pop();
        const cx = stack.pop();
        sz++;
        const neigh = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (!garment[ni] || label[ni] >= 0) continue;
          label[ni] = L;
          stack.push(nx, ny);
        }
      }
      sizes.push(sz);
      L++;
    }
  }
  if (sizes.length === 0) return new Uint8Array(w * h);
  let largest = sizes[0];
  let bestLab = 0;
  for (let k = 1; k < sizes.length; k++) {
    if (sizes[k] > largest) {
      largest = sizes[k];
      bestLab = k;
    }
  }
  const minArea = Math.max(480, Math.floor(w * h * 0.003));
  const threshold = Math.max(minArea, Math.ceil(largest * 0.072));
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const lab = label[i];
    if (lab < 0) continue;
    if (lab === bestLab || sizes[lab] >= threshold) out[i] = 1;
  }
  return out;
}

/**
 * Separable box blur on mask alpha only. One pass @ r=1 softens jagged upscaled silhouettes for product shots.
 */
function featherGarmentMaskAlpha(canvas, radius, passes) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2 || passes < 1 || radius < 1) return;
  const rUse = Math.max(1, Math.min(2, Math.round(radius)));
  const pUse = Math.max(2, Math.min(3, Math.round(passes)));
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const a0 = new Float32Array(n);
  const a1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    a0[i] = d[i * 4 + 3];
  }
  const kern = [0.05449, 0.2442, 0.40262, 0.2442, 0.05449];
  const lerp = (u, v, t) => u * (1 - t) + v * t;
  const blur1D = (src, dst, horizontal, offset) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) {
          const base = (horizontal ? x : y) + k * rUse + offset;
          const i0 = Math.floor(base);
          const i1 = i0 + 1;
          const t = base - i0;
          const c0 = horizontal
            ? Math.max(0, Math.min(w - 1, i0))
            : Math.max(0, Math.min(h - 1, i0));
          const c1 = horizontal
            ? Math.max(0, Math.min(w - 1, i1))
            : Math.max(0, Math.min(h - 1, i1));
          const s0 = horizontal ? src[y * w + c0] : src[c0 * w + x];
          const s1 = horizontal ? src[y * w + c1] : src[c1 * w + x];
          sum += lerp(s0, s1, t) * kern[k + 2];
        }
        dst[y * w + x] = sum;
      }
    }
  };
  for (let p = 0; p < pUse; p++) {
    blur1D(a0, a1, true, 0);
    blur1D(a1, a0, false, 0);
    /** Sub-pixel offset pass to reduce shoulder stair-stepping. */
    blur1D(a0, a1, true, p % 2 === 0 ? 0.5 : -0.5);
    blur1D(a1, a0, false, p % 2 === 0 ? 0.5 : -0.5);
  }
  for (let i = 0; i < n; i++) {
    const av = Math.max(0, Math.min(255, a0[i]));
    /**
     * Sigmoid edge alpha transition: keeps edge anti-aliasing natural without creating a soft glow band.
     */
    const t = sigmoid01(av / 255, 6.2);
    d[i * 4 + 3] = Math.round(255 * t);
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Keep AA only on the silhouette band:
 * - restore fully-solid interior alpha to 255 (removes "smudged" outlines),
 * - clamp tiny outer haze to 0 (prevents background tint bleed),
 * - preserve smooth anti-aliased transition on the contour itself.
 */
function confineFeatherToOuterContour(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2) return;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = d[i * 4 + 3];
  const out = new Uint8Array(a);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ai = a[i];
      /**
       * Continuous contour shaping:
       * blend local mean alpha with pixel alpha, then pass through a mild sigmoid.
       * This avoids branch-driven step artifacts on long sleeve curves.
       */
      let sumA = 0;
      let cntA = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sumA += a[ny * w + nx];
          cntA++;
        }
      }
      const meanA = cntA > 0 ? sumA / cntA : ai;
      const blended = ai * 0.58 + meanA * 0.42;
      if (blended >= 252) {
        out[i] = 255;
      } else if (blended <= 3) {
        out[i] = 0;
      } else {
        const t = sigmoid01(blended / 255, 5.7);
        out[i] = Math.round(255 * t);
      }
    }
  }
  for (let i = 0; i < n; i++) d[i * 4 + 3] = out[i];
  ctx.putImageData(img, 0, 0);
}

/**
 * Cutout PNGs: auto mask + dilate often extends past the asset’s real alpha (dark matting + jagged steps).
 * Clamp feathered mask alpha to the source image alpha so the silhouette matches the file’s anti-aliasing.
 */
function clipGarmentMaskAlphaToSourceImage(maskCanvas, sourceImg) {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  if (!sourceImg?.naturalWidth || w < 2 || h < 2) return;
  const mctx = maskCanvas.getContext("2d");
  const mImg = mctx.getImageData(0, 0, w, h);
  const md = mImg.data;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(
    sourceImg,
    0,
    0,
    sourceImg.naturalWidth,
    sourceImg.naturalHeight,
    0,
    0,
    w,
    h
  );
  const sd = tctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const ma = md[o + 3];
    const sa = sd[o + 3];
    md[o + 3] = ma <= sa ? ma : sa;
  }
  mctx.putImageData(mImg, 0, 0);
}

/**
 * Transparent-border catalog PNGs: binary `garment` only selects the main product blob; mask **opacity**
 * comes from the image’s own alpha at full resolution (no upscaled 0/1 blocks → no extra jaggies/halos).
 */
function composeAlphaCutoutMaskFullResFromSourceAlpha(
  img,
  garment,
  mw,
  mh,
  outCanvas
) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  outCanvas.width = nw;
  outCanvas.height = nh;
  const ctx = outCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);
  const src = ctx.getImageData(0, 0, nw, nh);
  const d = src.data;
  const n = nw * nh;
  const iw = Math.max(1, mw - 1);
  const ih = Math.max(1, mh - 1);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = i % nw;
    const y = (i / nw) | 0;
    const mx = Math.min(iw, Math.round((x * (mw - 1)) / Math.max(1, nw - 1)));
    const my = Math.min(ih, Math.round((y * (mh - 1)) / Math.max(1, nh - 1)));
    const gi = my * mw + mx;
    const sa = d[o + 3];
    d[o] = 255;
    d[o + 1] = 255;
    d[o + 2] = 255;
    d[o + 3] = garment[gi] ? sa : 0;
  }
  ctx.putImageData(src, 0, 0);
}

/**
 * Bicubic alpha upscale for mask edges (higher-order than canvas bilinear smoothing).
 * RGB is pinned to white; only alpha is reconstructed.
 */
function upscaleMaskBicubicAlpha(smallMask, nw, nh, outCanvas) {
  const sw = smallMask.width;
  const sh = smallMask.height;
  outCanvas.width = nw;
  outCanvas.height = nh;
  const sctx = smallMask.getContext("2d", { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, sw, sh).data;
  const octx = outCanvas.getContext("2d");
  const out = octx.createImageData(nw, nh);
  const od = out.data;
  const cubic = (p0, p1, p2, p3, t) => {
    const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
    const a2 = -0.5 * p0 + 0.5 * p2;
    const a3 = p1;
    return ((a0 * t + a1) * t + a2) * t + a3;
  };
  const sampleA = (x, y) => {
    const xx = Math.max(0, Math.min(sw - 1, x));
    const yy = Math.max(0, Math.min(sh - 1, y));
    return sd[(yy * sw + xx) * 4 + 3];
  };
  for (let y = 0; y < nh; y++) {
    const sy = (y * (sh - 1)) / Math.max(1, nh - 1);
    const y0 = Math.floor(sy);
    const ty = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = (x * (sw - 1)) / Math.max(1, nw - 1);
      const x0 = Math.floor(sx);
      const tx = sx - x0;
      const col = new Float32Array(4);
      for (let m = -1; m <= 2; m++) {
        const yy = y0 + m;
        const p0 = sampleA(x0 - 1, yy);
        const p1 = sampleA(x0, yy);
        const p2 = sampleA(x0 + 1, yy);
        const p3 = sampleA(x0 + 2, yy);
        col[m + 1] = cubic(p0, p1, p2, p3, tx);
      }
      const a = Math.max(0, Math.min(255, cubic(col[0], col[1], col[2], col[3], ty)));
      const o = (y * nw + x) * 4;
      od[o] = 255;
      od[o + 1] = 255;
      od[o + 2] = 255;
      od[o + 3] = Math.round(a);
    }
  }
  octx.putImageData(out, 0, 0);
}

/** Remove tiny disconnected foreground blobs (mask errors in hood / seams) while keeping the largest component. */
function pruneTinyGarmentBlobs(garment, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  let L = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!garment[i] || label[i] >= 0) continue;
      const stack = [x, y];
      label[i] = L;
      let sz = 0;
      while (stack.length) {
        const cy = stack.pop();
        const cx = stack.pop();
        sz++;
        const neigh = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const ni = ny * w + nx;
          if (!garment[ni] || label[ni] >= 0) continue;
          label[ni] = L;
          stack.push(nx, ny);
        }
      }
      sizes.push(sz);
      L++;
    }
  }
  if (sizes.length === 0) return garment;
  let best = 0;
  for (let k = 1; k < sizes.length; k++) {
    if (sizes[k] > sizes[best]) best = k;
  }
  const T = Math.max(620, Math.floor(w * h * 0.0003));
  const out = new Uint8Array(garment);
  for (let i = 0; i < n; i++) {
    const lab = label[i];
    if (lab < 0) continue;
    if (lab !== best && sizes[lab] < T) out[i] = 0;
  }
  return out;
}

function dilateAlphaPlaneUint8(alpha, w, h, passes) {
  let a = new Uint8Array(alpha);
  let b = new Uint8Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            m = Math.max(m, a[ny * w + nx]);
          }
        }
        b[y * w + x] = m;
      }
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

function erodeAlphaPlaneUint8(alpha, w, h, passes) {
  let a = new Uint8Array(alpha);
  let b = new Uint8Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 255;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
              m = 0;
            } else {
              m = Math.min(m, a[ny * w + nx]);
            }
          }
        }
        b[y * w + x] = m;
      }
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/** ~1px inward on mask alpha (catalog cutouts) before feather — drops outer matting ring / green bleed. */
function erodeGarmentMaskCanvasAlpha(canvas, passes) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2 || passes < 1) return;
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    a[i] = d[i * 4 + 3];
  }
  const out = erodeAlphaPlaneUint8(a, w, h, passes);
  for (let i = 0; i < n; i++) {
    d[i * 4 + 3] = out[i];
  }
  ctx.putImageData(img, 0, 0);
}

function ensureMaskPaintCanvases() {
  const nw = state.baseNaturalW;
  const nh = state.baseNaturalH;
  if (!nw || !nh) return;
  if (!state.maskPaintAdd) state.maskPaintAdd = document.createElement("canvas");
  if (!state.maskPaintSub) state.maskPaintSub = document.createElement("canvas");
  if (state.maskPaintAdd.width !== nw || state.maskPaintAdd.height !== nh) {
    state.maskPaintAdd.width = nw;
    state.maskPaintAdd.height = nh;
    state.maskPaintSub.width = nw;
    state.maskPaintSub.height = nh;
    state.maskPaintAdd.getContext("2d").clearRect(0, 0, nw, nh);
    state.maskPaintSub.getContext("2d").clearRect(0, 0, nw, nh);
  }
}

function clearMaskPaintLayers() {
  if (!state.baseNaturalW) return;
  ensureMaskPaintCanvases();
  const nw = state.baseNaturalW;
  const nh = state.baseNaturalH;
  state.maskPaintAdd.getContext("2d").clearRect(0, 0, nw, nh);
  state.maskPaintSub.getContext("2d").clearRect(0, 0, nw, nh);
}

/**
 * Rebuild `garmentMaskCanvas` from auto mask + grow/shrink + optional brush layers + extra feather.
 */
function syncRefinedGarmentMask() {
  const auto = state.maskAutoCanvas;
  if (!auto || !auto.width || !state.baseImg) return;
  const nw = state.baseNaturalW;
  const nh = state.baseNaturalH;
  if (auto.width !== nw || auto.height !== nh) return;

  if (!state.garmentMaskCanvas)
    state.garmentMaskCanvas = document.createElement("canvas");
  state.garmentMaskCanvas.width = nw;
  state.garmentMaskCanvas.height = nh;
  const ctx = state.garmentMaskCanvas.getContext("2d");
  ctx.drawImage(auto, 0, 0);
  const img = ctx.getImageData(0, 0, nw, nh);
  const d = img.data;
  const n = nw * nh;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = d[i * 4 + 3];
  }

  let a = alpha;
  const adj = Math.max(-10, Math.min(10, Math.round(state.maskEdgeAdjust)));
  if (adj > 0) a = dilateAlphaPlaneUint8(a, nw, nh, adj);
  else if (adj < 0) a = erodeAlphaPlaneUint8(a, nw, nh, -adj);

  ensureMaskPaintCanvases();
  if (
    state.maskPaintAdd &&
    state.maskPaintAdd.width === nw &&
    state.maskPaintSub?.width === nw
  ) {
    const addD = state.maskPaintAdd.getContext("2d").getImageData(0, 0, nw, nh)
      .data;
    const subD = state.maskPaintSub.getContext("2d").getImageData(0, 0, nw, nh)
      .data;
    for (let i = 0; i < n; i++) {
      let v = a[i];
      v = Math.min(255, v + addD[i * 4 + 3]);
      v = Math.max(0, v - subD[i * 4 + 3]);
      a[i] = v;
    }
  }
  for (let i = 0; i < n; i++) {
    d[i * 4 + 3] = a[i];
  }
  ctx.putImageData(img, 0, 0);

  const ex = Math.max(0, Math.min(3, Math.round(state.maskExtraFeather)));
  if (ex > 0) {
    featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, ex);
  }
  confineFeatherToOuterContour(state.garmentMaskCanvas);
  {
    const px = nw * nh;
    let aaFactor = 2;
    if (state.alphaCutoutGarmentMask) {
      if (px <= 2_250_000) aaFactor = 4;
      else if (px <= 8_000_000) aaFactor = 3;
    }
    supersampleMaskAlphaAA(state.garmentMaskCanvas, aaFactor);
  }
  state.maskGeneration = (state.maskGeneration + 1) | 0;
}

function clientToPreviewCanvasPx(clientX, clientY) {
  const c = els.previewCanvas;
  const rect = c.getBoundingClientRect();
  const x = ((clientX - rect.left) / Math.max(1, rect.width)) * c.width;
  const y = ((clientY - rect.top) / Math.max(1, rect.height)) * c.height;
  return { x, y };
}

function previewCanvasPxToNatural(px, py) {
  const c = els.previewCanvas;
  const nw = state.baseNaturalW;
  const nh = state.baseNaturalH;
  let nx = (px / Math.max(1, c.width)) * nw;
  let ny = (py / Math.max(1, c.height)) * nh;
  nx = Math.max(0, Math.min(nw - 1e-6, nx));
  ny = Math.max(0, Math.min(nh - 1e-6, ny));
  return { x: nx, y: ny };
}

function stampMaskBrush(nx, ny, mode) {
  ensureMaskPaintCanvases();
  const target =
    mode === "add" ? state.maskPaintAdd : state.maskPaintSub;
  const sctx = target.getContext("2d");
  const r = Math.max(4, state.maskBrushSizeNat);
  const g = sctx.createRadialGradient(nx, ny, 0, nx, ny, r);
  g.addColorStop(0, "rgba(255,255,255,0.88)");
  g.addColorStop(0.45, "rgba(255,255,255,0.32)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  sctx.save();
  sctx.globalCompositeOperation = "source-over";
  sctx.globalAlpha = mode === "add" ? 0.72 : 0.68;
  sctx.fillStyle = g;
  sctx.beginPath();
  sctx.arc(nx, ny, r, 0, Math.PI * 2);
  sctx.fill();
  sctx.restore();
}

function syncMaskRefineLabels() {
  if (els.maskEdgeAdjustVal) {
    const v = Number(els.maskEdgeAdjust?.value ?? 0);
    els.maskEdgeAdjustVal.textContent =
      v === 0 ? "0" : v > 0 ? `+${v} grow` : `${v} shrink`;
  }
  if (els.maskExtraFeatherVal) {
    els.maskExtraFeatherVal.textContent = String(
      Math.round(Number(els.maskExtraFeather?.value ?? 0))
    );
  }
  if (els.maskBrushSizeVal) {
    els.maskBrushSizeVal.textContent = `${Math.round(state.maskBrushSizeNat)} px`;
  }
}

function updateMaskPaintOverlayInteractivity() {
  const o = els.maskPaintOverlay;
  if (!o) return;
  const on = state.maskBrushMode !== "off" && state.baseImg;
  o.style.pointerEvents = on ? "auto" : "none";
  o.style.cursor = on ? "crosshair" : "default";
}

function drawMaskBrushCursorOverlay(clientX, clientY) {
  const o = els.maskPaintOverlay;
  const c = els.previewCanvas;
  if (!o || !state.baseImg || state.maskBrushMode === "off") return;
  if (o.width !== c.width || o.height !== c.height) {
    o.width = c.width;
    o.height = c.height;
  }
  const ox = o.getContext("2d");
  ox.clearRect(0, 0, o.width, o.height);
  const { x, y } = clientToPreviewCanvasPx(clientX, clientY);
  const rNat = Math.max(4, state.maskBrushSizeNat);
  const r =
    (rNat * c.width) / Math.max(1, state.baseNaturalW);
  ox.strokeStyle =
    state.maskBrushMode === "add"
      ? "rgba(34, 197, 94, 0.85)"
      : "rgba(239, 68, 68, 0.85)";
  ox.lineWidth = 2;
  ox.beginPath();
  ox.arc(x, y, Math.max(2, r), 0, Math.PI * 2);
  ox.stroke();
}

/**
 * Clean AI/rembg alpha: bridge gaps, fill modest interior holes, drop backdrop-colored fringe, trim outer ring.
 */
function refineExternalCutoutBinary(maskRgba, baseRgba, mw, mh) {
  const n = mw * mh;
  let garment = new Uint8Array(n);
  /**
   * AI matting often uses mid-alpha on deep maroon / shadow — a hard 92 threshold punches
   * white “holes” and black hood artifacts after binarize. ~68 keeps fabric while morph+cull trim key.
   */
  for (let i = 0; i < n; i++) {
    garment[i] = maskRgba[i * 4 + 3] > 68 ? 1 : 0;
  }
  garment = morphCloseBinary(garment, mw, mh, 2);
  garment = mergeSignificantGarmentComponents(garment, mw, mh);
  const maxHole = Math.max(26000, Math.floor(n * 0.017));
  garment = fillSmallEnclosedHoles(garment, mw, mh, maxHole, baseRgba);
  garment = cullBackdropFringeFromMask(garment, baseRgba, mw, mh);
  garment = cullRedMattingFringe(garment, baseRgba, mw, mh);
  garment = cullGreenMattingFringe(garment, baseRgba, mw, mh);
  garment = morphOpenBinary(garment, mw, mh, 1);
  garment = erodeBinaryTimes(garment, mw, mh, 1);
  const maxHoleAfterTrim = Math.max(16000, Math.floor(n * 0.007));
  garment = fillSmallEnclosedHoles(garment, mw, mh, maxHoleAfterTrim, baseRgba);
  garment = binaryMajoritySmooth(garment, mw, mh);
  garment = cullChromaKeySpillFromBinaryGarment(garment, baseRgba, mw, mh);
  return toStrictBinary01(garment, mw, mh);
}

/**
 * Use alpha from a rembg (or any) cutout PNG as the garment mask. Scales to the loaded base photo size.
 * Solves “red shirt on red background” where in-browser edge heuristics have no chroma contrast.
 */
function applyRembgMaskFromImage(maskImg) {
  const nw = state.baseNaturalW;
  const nh = state.baseNaturalH;
  if (!state.baseImg || !nw || !nh) {
    setStatus("Load the garment photo first, then the cutout PNG.", "error");
    return;
  }
  state.maskHighKeyStudio = false;

  const scale = Math.min(1, EXT_MASK_REFINE_MAX / Math.max(nw, nh));
  const mw = Math.max(2, Math.round(nw * scale));
  const mh = Math.max(2, Math.round(nh * scale));

  const maskSmall = document.createElement("canvas");
  maskSmall.width = mw;
  maskSmall.height = mh;
  const msctx = maskSmall.getContext("2d");
  msctx.imageSmoothingEnabled = true;
  msctx.imageSmoothingQuality = "high";
  msctx.drawImage(maskImg, 0, 0, nw, nh, 0, 0, mw, mh);
  const maskSd = msctx.getImageData(0, 0, mw, mh).data;

  let maxA = 0;
  for (let i = 0; i < mw * mh; i++) {
    const a = maskSd[i * 4 + 3];
    if (a > maxA) maxA = a;
  }
  if (maxA < 10) {
    setStatus(
      "No usable alpha channel — use PNG from rembg (transparent background).",
      "error"
    );
    return;
  }

  const baseSmall = document.createElement("canvas");
  baseSmall.width = mw;
  baseSmall.height = mh;
  const bsctx = baseSmall.getContext("2d", { willReadFrequently: true });
  bsctx.imageSmoothingEnabled = true;
  bsctx.imageSmoothingQuality = "high";
  bsctx.drawImage(state.baseImg, 0, 0, nw, nh, 0, 0, mw, mh);
  const baseSd = bsctx.getImageData(0, 0, mw, mh).data;

  const garment = refineExternalCutoutBinary(maskSd, baseSd, mw, mh);
  const smallRgba = binaryMaskToSoftRgba(garment, mw, mh);

  const smallMask = document.createElement("canvas");
  smallMask.width = mw;
  smallMask.height = mh;
  smallMask.getContext("2d").putImageData(new ImageData(smallRgba, mw, mh), 0, 0);

  if (!state.garmentMaskCanvas)
    state.garmentMaskCanvas = document.createElement("canvas");
  state.garmentMaskCanvas.width = nw;
  state.garmentMaskCanvas.height = nh;
  upscaleMaskBicubicAlpha(smallMask, nw, nh, state.garmentMaskCanvas);

  featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, 2);
  clipGarmentMaskAlphaToSourceImage(state.garmentMaskCanvas, state.baseImg);
  featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, 1);

  if (!state.maskAutoCanvas) state.maskAutoCanvas = document.createElement("canvas");
  state.maskAutoCanvas.width = nw;
  state.maskAutoCanvas.height = nh;
  state.maskAutoCanvas.getContext("2d").drawImage(state.garmentMaskCanvas, 0, 0);
  clearMaskPaintLayers();
  state.externalMaskActive = true;
  state.alphaCutoutGarmentMask = true;
  syncRefinedGarmentMask();
  updateMaskPaintOverlayInteractivity();
  redrawPreview();
  setStatus(
    "Garment masked (mask PNG). Preview updates with your swatches — refine edges in Advanced if needed.",
    "ok"
  );
}

function rebuildGarmentMask() {
  const img = state.baseImg;
  if (!img || !img.naturalWidth) {
    state.garmentMaskCanvas = null;
    state.maskAutoCanvas = null;
    state.maskPaintAdd = null;
    state.maskPaintSub = null;
    state.externalMaskActive = false;
    state.maskHighKeyStudio = false;
    state.alphaCutoutGarmentMask = false;
    return;
  }
  state.externalMaskActive = false;

  const nw = img.naturalWidth;
  const nh = img.naturalHeight;

  const scale = Math.min(1, MASK_BUILD_MAX / Math.max(nw, nh));
  const mw = Math.max(2, Math.round(nw * scale));
  const mh = Math.max(2, Math.round(nh * scale));

  const sample = document.createElement("canvas");
  sample.width = mw;
  sample.height = mh;
  const sctx = sample.getContext("2d", { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(img, 0, 0, mw, mh);

  const { data } = sctx.getImageData(0, 0, mw, mh);
  const { highKey: highKeyWhiteStudio } = analyzeBorderHighKeyStudio(data, mw, mh);
  state.maskHighKeyStudio = highKeyWhiteStudio;

  const useAlphaCutoutMask = detectLikelyPngAlphaCutout(data, mw, mh);
  /**
   * Enclosed-hole fill helps hood/cuff specks. Too large a cap fills sleeve–torso wedges (backdrop) and they tint solid.
   * Single pass + one dilate balances hood vs armpits.
   */
  const maxHoleArea = Math.max(4200, Math.floor(mw * mh * 0.00285));

  let garment;

  if (useAlphaCutoutMask) {
    // ---------------------------------------------------
    // STEP A: Component pick only — opacity comes from native PNG alpha at full res (see STEP 4).
    // Low threshold keeps anti-aliased fringe attached to the main blob; avoid dilate / majority (stair-steps).
    // ---------------------------------------------------
    garment = new Uint8Array(mw * mh);
    for (let i = 0; i < mw * mh; i++) {
      garment[i] = data[i * 4 + 3] > 14 ? 1 : 0;
    }
    garment = mergeSignificantGarmentComponents(garment, mw, mh);
    garment = fillSmallEnclosedHoles(garment, mw, mh, maxHoleArea, null);
    garment = morphCloseBinary(garment, mw, mh, 1);
    garment = mergeSignificantGarmentComponents(garment, mw, mh);
    garment = pruneTinyGarmentBlobs(garment, mw, mh);
    garment = toStrictBinary01(garment, mw, mh);
  } else {
    // ---------------------------------------------------
    // STEP 1: Edges = luminance + chrominance + Laplacian (soft drop shadows on white: weak 1st
    // derivative along a wide ramp; 2nd derivative still peaks at the garment silhouette).
    // ---------------------------------------------------

    const luminance = new Float32Array(mw * mh);
    for (let i = 0; i < mw * mh; i++) {
      const p = i * 4;
      luminance[i] =
        0.2126 * data[p] +
        0.7152 * data[p + 1] +
        0.0722 * data[p + 2];
    }

    const edges = new Uint8Array(mw * mh);
    let edgeThreshold = Math.min(
      44,
      Math.max(10, Math.round(state.maskTolerance * 0.52))
    );
    if (highKeyWhiteStudio) {
      edgeThreshold = Math.max(6, Math.round(edgeThreshold * 0.76));
    }
    const lapWeight = highKeyWhiteStudio ? 0.52 : 0.34;
    const lapCap = highKeyWhiteStudio ? 112 : 88;

    for (let y = 1; y < mh - 1; y++) {
      for (let x = 1; x < mw - 1; x++) {
        const i = y * mw + x;
        const gxL = luminance[i + 1] - luminance[i - 1];
        const gyL = luminance[i + mw] - luminance[i - mw];
        const magL = Math.abs(gxL) + Math.abs(gyL);

        const ix1 = (i + 1) * 4;
        const ix0 = (i - 1) * 4;
        const iy1 = (i + mw) * 4;
        const iy0 = (i - mw) * 4;
        let magC = 0;
        for (let c = 0; c < 3; c++) {
          const gxc = data[ix1 + c] - data[ix0 + c];
          const gyc = data[iy1 + c] - data[iy0 + c];
          magC = Math.max(magC, Math.abs(gxc) + Math.abs(gyc));
        }

        const lap = Math.abs(
          luminance[i - mw] +
            luminance[i + mw] +
            luminance[i - 1] +
            luminance[i + 1] -
            4 * luminance[i]
        );
        const mag = magL + 0.55 * magC + lapWeight * Math.min(lapCap, lap);
        if (mag > edgeThreshold) edges[i] = 1;
      }
    }

    // Widen edge barriers so tiny gaps (armpits / JPEG) do not let border flood into the garment.
    // High-key flat-lays: +1px closes breaks along very soft shadow ramps.
    const edgeBarrier = dilateBinaryTimes(edges, mw, mh, highKeyWhiteStudio ? 2 : 1);

    // ---------------------------------------------------
    // STEP 2: Flood background from borders (blocked by edges)
    // ---------------------------------------------------

    const bg = new Uint8Array(mw * mh);
    const stack = [];

    const push = (x, y) => {
      if (x < 0 || x >= mw || y < 0 || y >= mh) return;
      const i = y * mw + x;
      if (bg[i]) return;
      if (edgeBarrier[i]) return;
      bg[i] = 1;
      stack.push(x, y);
    };

    for (let x = 0; x < mw; x++) {
      push(x, 0);
      push(x, mh - 1);
    }
    for (let y = 0; y < mh; y++) {
      push(0, y);
      push(mw - 1, y);
    }

    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }

    // ---------------------------------------------------
    // STEP 3: Garment = NOT background
    // ---------------------------------------------------

    garment = new Uint8Array(mw * mh);
    for (let i = 0; i < mw * mh; i++) {
      garment[i] = bg[i] ? 0 : 1;
    }

    garment = mergeSignificantGarmentComponents(garment, mw, mh);
    garment = fillSmallEnclosedHoles(garment, mw, mh, maxHoleArea, data);
    // Light close only — strong closing fills real sleeve–torso gaps with tint (unnatural vs photo).
    garment = morphCloseBinary(garment, mw, mh, 1);
    garment = morphOpenBinary(garment, mw, mh, 1);
    garment = cullBackdropFringeFromMask(garment, data, mw, mh);
    garment = morphCloseBinary(garment, mw, mh, 1);
    garment = mergeSignificantGarmentComponents(garment, mw, mh);
    garment = binaryMajoritySmooth(garment, mw, mh);
    garment = binaryMajoritySmooth(garment, mw, mh);
    garment = cullBackdropFringeFromMask(garment, data, mw, mh);
    /** +2px nominal reach closes sleeve–torso gaps where fringe read as cyan on white. */
    garment = dilateBinaryTimes(garment, mw, mh, 1);
    garment = pruneTinyGarmentBlobs(garment, mw, mh);
    garment = cullChromaKeySpillFromBinaryGarment(garment, data, mw, mh);
    garment = toStrictBinary01(garment, mw, mh);
  }

  state.alphaCutoutGarmentMask = useAlphaCutoutMask;

  // ---------------------------------------------------
  // STEP 4: Build full-res mask
  // ---------------------------------------------------

  if (!state.garmentMaskCanvas)
    state.garmentMaskCanvas = document.createElement("canvas");

  if (useAlphaCutoutMask) {
    composeAlphaCutoutMaskFullResFromSourceAlpha(
      img,
      garment,
      mw,
      mh,
      state.garmentMaskCanvas
    );
    erodeGarmentMaskCanvasAlpha(state.garmentMaskCanvas, 1);
    featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, 2);
    clipGarmentMaskAlphaToSourceImage(state.garmentMaskCanvas, img);
    featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, 1);
  } else {
    const rgba = binaryMaskToSoftRgba(garment, mw, mh);

    const smallMask = document.createElement("canvas");
    smallMask.width = mw;
    smallMask.height = mh;
    smallMask.getContext("2d").putImageData(new ImageData(rgba, mw, mh), 0, 0);

    state.garmentMaskCanvas.width = nw;
    state.garmentMaskCanvas.height = nh;

    upscaleMaskBicubicAlpha(smallMask, nw, nh, state.garmentMaskCanvas);
    /** Keep contour AA but avoid over-softening the entire silhouette. */
    featherGarmentMaskAlpha(state.garmentMaskCanvas, 1, 1);
    confineFeatherToOuterContour(state.garmentMaskCanvas);
  }

  if (!state.maskAutoCanvas) state.maskAutoCanvas = document.createElement("canvas");
  state.maskAutoCanvas.width = nw;
  state.maskAutoCanvas.height = nh;
  state.maskAutoCanvas.getContext("2d").drawImage(state.garmentMaskCanvas, 0, 0);
  clearMaskPaintLayers();
  syncRefinedGarmentMask();

  setStatus(
    useAlphaCutoutMask
      ? "Garment masked (PNG alpha — mint/teal products & cutouts). Tap a swatch to preview, then Generate WebPs."
      : highKeyWhiteStudio
        ? "Garment masked (studio white — soft shadow edges). Tap a swatch to preview, then export."
        : "Garment masked (edge-based). Tap a swatch to preview colors, then Generate WebPs.",
    "ok"
  );
}

function drawDesignLayer(ctx, w, h, design, opts = {}) {
  if (!design || !design.complete || !design.naturalWidth) return;
  const dw = design.naturalWidth;
  const dh = design.naturalHeight;
  const baseW = w * (state.designScalePct / 100);
  const scale = baseW / dw;
  const rw = dw * scale;
  const rh = dh * scale;
  const cx = state.designNx * w;
  const cy = state.designNy * h;
  const blurPx = opts.blurPx ?? 0;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((state.designRotDeg * Math.PI) / 180);
  if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(design, -rw / 2, -rh / 2, rw, rh);
  ctx.restore();
}

function getDesignScratchCanvas(w, h) {
  if (!state.designScratchCanvas)
    state.designScratchCanvas = document.createElement("canvas");
  if (
    state.designScratchCanvas.width !== w ||
    state.designScratchCanvas.height !== h
  ) {
    state.designScratchCanvas.width = w;
    state.designScratchCanvas.height = h;
  }
  return state.designScratchCanvas;
}

/**
 * Per-pixel: where design exists, scale RGB by garment luminance so ink follows folds (see snapshot before design).
 */
function applyDesignFabricLightingFromSnapshots(
  ctx,
  w,
  h,
  garmentImgData,
  designScratchCanvas
) {
  const strength = Math.max(0, Math.min(1, state.designFabricBlend));
  if (strength < 0.001) return;
  const sx = designScratchCanvas.getContext("2d");
  const dd = sx.getImageData(0, 0, w, h).data;
  const gd = garmentImgData.data;
  const main = ctx.getImageData(0, 0, w, h);
  const md = main.data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const da = dd[o + 3];
    if (da < 3) continue;
    const t = strength * smoothstep01(da / 255);
    if (t < 0.002) continue;
    const L = luminanceRgb(gd[o], gd[o + 1], gd[o + 2]);
    const u = Math.pow(Math.min(255, Math.max(0, L)) / 255, 0.86);
    const targetFactor = 0.4 + 0.6 * u;
    const factor = 1 + t * (targetFactor - 1);
    md[o] = Math.min(255, Math.max(0, Math.round(md[o] * factor)));
    md[o + 1] = Math.min(255, Math.max(0, Math.round(md[o + 1] * factor)));
    md[o + 2] = Math.min(255, Math.max(0, Math.round(md[o + 2] * factor)));
  }
  ctx.putImageData(main, 0, 0);
}

function drawDesignWithFabricBlend(ctx, w, h, design, garmentSnapshot) {
  if (!design || !design.complete || !design.naturalWidth) return;
  const strength = state.designFabricBlend;
  const blurPx =
    strength > 0.02 ? Math.max(0, state.designPrintBlurPx) : 0;
  if (strength < 0.005 || !garmentSnapshot) {
    drawDesignLayer(ctx, w, h, design, { blurPx });
    return;
  }
  const scratch = getDesignScratchCanvas(w, h);
  const sx = scratch.getContext("2d");
  sx.clearRect(0, 0, w, h);
  drawDesignLayer(sx, w, h, design, { blurPx });
  drawDesignLayer(ctx, w, h, design, { blurPx });
  applyDesignFabricLightingFromSnapshots(ctx, w, h, garmentSnapshot, scratch);
}

function parseHexRgb(hex) {
  let h = String(hex)
    .replace("#", "")
    .trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return { r: 255, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminanceRgb(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgb8ToHsl(r8, g8, b8) {
  const r = Math.max(0, Math.min(1, r8 / 255));
  const g = Math.max(0, Math.min(1, g8 / 255));
  const b = Math.max(0, Math.min(1, b8 / 255));
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) * 0.5;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb8(h, s, l) {
  const hh = ((h % 1) + 1) % 1;
  const ss = Math.max(0, Math.min(1, s));
  const ll = Math.max(0, Math.min(1, l));
  if (ss < 1e-6) {
    const v = Math.round(ll * 255);
    return { r: v, g: v, b: v };
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const hue2rgb = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue2rgb(hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(hh) * 255),
    b: Math.round(hue2rgb(hh - 1 / 3) * 255),
  };
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function sigmoid01(t, k = 10) {
  const x = Math.max(0, Math.min(1, t));
  const v = 1 / (1 + Math.exp(-k * (x - 0.5)));
  const v0 = 1 / (1 + Math.exp(k * 0.5));
  const v1 = 1 / (1 + Math.exp(-k * 0.5));
  return (v - v0) / Math.max(1e-6, v1 - v0);
}

/**
 * Catalog fringe toward #FFFFFF: pushing L* → 100 on **already bright** edge pixels (highlights, white×tint
 * multiply) reads as a pale glow. Weaken the blend when sRGB luminance is high; dark mud fringes unchanged.
 */
function attenuatePureWhiteFringeEb(or, og, ob, eb) {
  if (eb < 1e-6) return eb;
  const lumG = luminanceRgb(or, og, ob);
  const hi = smoothstep01((lumG - 172) / 52);
  return eb * (1 - 0.92 * hi);
}

/** sRGB 8-bit → linear 0..1 */
function linearFromSrgb8(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear 0..1 → sRGB 8-bit */
function srgb8ChannelFromLinear(c) {
  c = Math.max(0, Math.min(1, c));
  return Math.round(
    (c <= 0.0031308
      ? 12.92 * c
      : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255
  );
}

function rgbLinToXyzLin(r, g, b) {
  return {
    X: 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    Y: 0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    Z: 0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  };
}

function xyzToLab(X, Y, Z) {
  const Xn = 0.95047;
  const Yn = 1;
  const Zn = 1.08883;
  const x = X / Xn;
  const y = Y / Yn;
  const z = Z / Zn;
  const eps = 216 / 24389;
  const k = 24389 / 27;
  const fx = x > eps ? Math.cbrt(x) : (k * x + 16) / 116;
  const fy = y > eps ? Math.cbrt(y) : (k * y + 16) / 116;
  const fz = z > eps ? Math.cbrt(z) : (k * z + 16) / 116;
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function labToXyz(L, a, b) {
  const Xn = 0.95047;
  const Yn = 1;
  const Zn = 1.08883;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const eps = 216 / 24389;
  const k = 24389 / 27;
  const xr = fx ** 3 > eps ? fx ** 3 : (116 * fx - 16) / k;
  const yr = fy ** 3 > eps ? fy ** 3 : (116 * fy - 16) / k;
  const zr = fz ** 3 > eps ? fz ** 3 : (116 * fz - 16) / k;
  return { X: xr * Xn, Y: yr * Yn, Z: zr * Zn };
}

function xyzToRgbLin(X, Y, Z) {
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return {
    r: Math.max(0, Math.min(1, r)),
    g: Math.max(0, Math.min(1, g)),
    b: Math.max(0, Math.min(1, b)),
  };
}

function srgb8RgbToLab(r8, g8, b8) {
  const r = linearFromSrgb8(r8);
  const g = linearFromSrgb8(g8);
  const b = linearFromSrgb8(b8);
  const xyz = rgbLinToXyzLin(r, g, b);
  return xyzToLab(xyz.X, xyz.Y, xyz.Z);
}

function labToSrgb8(L, a, b) {
  const xyz = labToXyz(L, a, b);
  const rgb = xyzToRgbLin(xyz.X, xyz.Y, xyz.Z);
  return {
    r: srgb8ChannelFromLinear(rgb.r),
    g: srgb8ChannelFromLinear(rgb.g),
    b: srgb8ChannelFromLinear(rgb.b),
  };
}

function boxBlurFloat2DSeparate(src, w, h, rad) {
  if (rad < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dx = -rad; dx <= rad; dx++) {
        const nx = Math.max(0, Math.min(w - 1, x + dx));
        s += src[row + nx];
        c++;
      }
      tmp[row + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const ny = Math.max(0, Math.min(h - 1, y + dy));
        s += tmp[ny * w + x];
        c++;
      }
      dst[y * w + x] = s / c;
    }
  }
  return dst;
}

/**
 * Separable box blur using only samples with `maskA >= minMask` so catalog **white backdrop** (L*≈100) does not
 * leak into garment **L\*** clarity baseline at the silhouette.
 */
function boxBlurFloat2DSeparateMasked(src, maskA, w, h, rad, minMask = 38) {
  if (rad < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      let s = 0;
      let c = 0;
      for (let dx = -rad; dx <= rad; dx++) {
        const nx = Math.max(0, Math.min(w - 1, x + dx));
        const j = row + nx;
        if (maskA[j] >= minMask) {
          s += src[j];
          c++;
        }
      }
      tmp[i] = c > 0 ? s / c : src[i];
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let s = 0;
      let c = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const ny = Math.max(0, Math.min(h - 1, y + dy));
        const j = ny * w + x;
        if (maskA[j] >= minMask) {
          s += tmp[j];
          c++;
        }
      }
      dst[i] = c > 0 ? s / c : tmp[i];
    }
  }
  return dst;
}

/**
 * Per render size: neutral grayscale + luminance Y + achromatic shadow multiply + texture residual (cached).
 */
function buildRecolorDecomposition(w, h, baseImage, maskNatCanvas) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(baseImage, 0, 0, w, h);
  const prep = prepareMaskedNeutralBasePixels(tctx, w, h, maskNatCanvas);
  const d = prep.d;
  const alphaRaw = prep.alphaRaw;
  const alphaNeighborMax = prep.alphaNeighborMax;
  const n = prep.n;
  const Ylin = new Float32Array(n);
  const Lstar = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r8 = d[o];
    const g8 = d[o + 1];
    const b8 = d[o + 2];
    const lr = linearFromSrgb8(r8);
    const lg = linearFromSrgb8(g8);
    const lb = linearFromSrgb8(b8);
    Ylin[i] = Math.max(1e-6, 0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
    const lab = srgb8RgbToLab(r8, g8, b8);
    Lstar[i] = lab.L;
  }
  const rBig = Math.max(2, Math.min(56, Math.round(Math.min(w, h) / 42)));
  const rSmall = Math.max(1, Math.min(10, Math.round(Math.min(w, h) / 160)));
  const Yb = boxBlurFloat2DSeparate(Ylin, w, h, rBig);
  const Ys = boxBlurFloat2DSeparate(Ylin, w, h, rSmall);
  const texUser = Math.max(0, Math.min(0.55, state.texturePreserve));
  /** Stronger high-pass fabric grain (was too subtle vs reference mockups). */
  const texGain = 0.58 + texUser * 2.85;
  const mult = new Float32Array(n);
  const tex = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mult[i] = Math.max(
      0.28,
      Math.min(1.24, Ylin[i] / Math.max(Yb[i], 1e-5))
    );
    tex[i] = (Ylin[i] - Ys[i]) * texGain;
  }
  const neutralRgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    neutralRgba[o] = d[o];
    neutralRgba[o + 1] = d[o + 1];
    neutralRgba[o + 2] = d[o + 2];
    neutralRgba[o + 3] = 255;
  }
  const maskEdgeGrad = computeMaskAlphaGradientMax(
    alphaRaw,
    w,
    h,
    state.alphaCutoutGarmentMask ? 2 : 1
  );
  const neutralMaxNeighL = computeNeutralNeighborMaxLuma3x3(neutralRgba, w, h);
  return {
    w,
    h,
    n,
    Lstar,
    mult,
    tex,
    alphaRaw,
    Ylin,
    neutralRgba,
    maskEdgeGrad,
    neutralMaxNeighL,
    alphaNeighborMax,
  };
}

function ensureRecolorDecomposition(w, h, baseImage, maskNatCanvas) {
  const key = `${w}x${h}_${state.activeBaseId}_${state.maskGeneration}_t${Math.round(
    (state.texturePreserve ?? 0) * 1e4
  )}_pw${state.pureWhiteProductMode ? 1 : 0}_ac${state.alphaCutoutGarmentMask ? 1 : 0}_pr8`;
  const prev = state.recolorDecomp;
  if (
    prev &&
    prev.key === key &&
    prev.w === w &&
    prev.h === h
  ) {
    return prev;
  }
  const decomp = buildRecolorDecomposition(w, h, baseImage, maskNatCanvas);
  decomp.key = key;
  state.recolorDecomp = decomp;
  return decomp;
}

/**
 * Perceptual **color transfer** (not a flat overlay): L* and neutral texture from the photo, chroma from the
 * swatch; folds stay darker via achromatic shadow handling — like re-dyeing while keeping lighting structure.
 * For white/light shirts where you want strict **linear multiply** dye, use `multiplyTintRecolor` instead.
 */
function applyMaskedLabRecolor(
  ctx,
  w,
  h,
  garmentHex,
  maskNatCanvas,
  sceneHex,
  baseImage
) {
  const dec = ensureRecolorDecomposition(w, h, baseImage, maskNatCanvas);
  const {
    alphaRaw,
    mult,
    tex,
    n,
    neutralRgba,
    maskEdgeGrad,
    neutralMaxNeighL,
    alphaNeighborMax,
  } = dec;
  const { r: tr, g: tg, b: tb } = parseHexRgb(garmentHex);
  const tintHsl = rgb8ToHsl(tr, tg, tb);
  const pureBg = state.pureWhiteProductMode;
  const { r: bgR0, g: bgG0, b: bgB0 } = parseHexRgb(sceneHex);
  const bgR = pureBg ? 255 : bgR0;
  const bgG = pureBg ? 255 : bgG0;
  const bgB = pureBg ? 255 : bgB0;

  const img = ctx.getImageData(0, 0, w, h);
  const dd = img.data;

  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 2) continue;
    /**
     * Skip **only** true fringe specks. **Micro-gaps** on steep edges (`maskEdgeGrad` high) used to `continue`
     * here (`a<4`) and left the canvas as raw **white** → vertical “light leaks” along the silhouette.
     */
    if (pureBg && a < 4 && maskEdgeGrad[i] < 26) continue;
    const o = i * 4;

    const sr = neutralRgba[o];
    const sg = neutralRgba[o + 1];
    const sb = neutralRgba[o + 2];
    const srcLum = luminanceRgb(sr, sg, sb);
    const srcChroma = Math.max(sr, sg, sb) - Math.min(sr, sg, sb);
    /**
     * Weak mask + very dark neutral pixels are usually background gaps (underarm voids, negative spaces).
     * Keep bright low-alpha highlights, but suppress recolor in dark creases that are not fabric.
     */
    if (
      (a < 26 && srcLum < 62 && srcChroma < 24) ||
      (a < 44 && srcLum < 42 && srcChroma < 20)
    ) {
      continue;
    }

    /**
     * (No hard `continue` → backdrop here: it carved **white notches** on interior seams where one side is a
     * **light tint** and the other is **dark** — read as “bright neighbor + lum gap” but is real fabric.)
     * Contact shadow is handled softly via `contactShadowMatte` in `postTintKill` with **stricter** gray-on-white tests.
     */

    const srcHsl = rgb8ToHsl(sr, sg, sb);
    const chromaKeep = Math.max(0.7, Math.min(1, 0.9 + srcHsl.s * 0.22));
    /**
     * Linear-light style modulation of garment lightness:
     * preserve highlights/shadows while letting texture + local shading drive reflected tint depth.
     */
    const blendL = Math.max(0, Math.min(1, 0.5 + (mult[i] - 1) * 0.62));
    const llDelta = (2 * blendL - 1) * 0.16;
    const texLift = Math.max(-0.08, Math.min(0.08, tex[i] * 1.55));
    const modL = Math.max(0, Math.min(1, srcHsl.l + llDelta + texLift));
    const tintRgb = hslToRgb8(
      tintHsl.h,
      Math.min(1, tintHsl.s * chromaKeep),
      modL
    );

    const mulR = (sr * tr) / 255;
    const mulG = (sg * tg) / 255;
    const mulB = (sb * tb) / 255;
    let depthW = 0.18 + 0.34 * (1 - smoothstep01((srcLum - 42) / 170));
    /**
     * **Catalog white / dark-edge halo:** `mulR = sr×tr/255` dominates in shadows (`depthW` + `mW`). Neutral `sr`
     * at the silhouette is often still dark after prep → **tint × dark** reads as a muddy ring. On silhouette
     * cues, keep the **LAB tint path** and starve multiply toward the edge.
     */
    if (pureBg) {
      const gmh = maskEdgeGrad[i];
      const haloCue =
        smoothstep01((gmh - 8) / 88) *
        (1 - smoothstep01((srcLum - 28) / 100)) *
        smoothstep01((a - 56) / 152);
      depthW *= 1 - 0.68 * haloCue;
    }

    let colR = tintRgb.r * (1 - depthW) + mulR * depthW;
    let colG = tintRgb.g * (1 - depthW) + mulG * depthW;
    let colB = tintRgb.b * (1 - depthW) + mulB * depthW;
    if (srcLum < 100) {
      let mW = 0.74 + 0.26 * (1 - smoothstep01((srcLum - 18) / 82));
      if (pureBg) {
        const gmh = maskEdgeGrad[i];
        const haloCue =
          smoothstep01((gmh - 8) / 88) *
          (1 - smoothstep01((srcLum - 22) / 80)) *
          smoothstep01((a - 60) / 142);
        mW *= 1 - 0.85 * haloCue;
      }
      colR = colR * (1 - mW) + mulR * mW;
      colG = colG * (1 - mW) + mulG * mW;
      colB = colB * (1 - mW) + mulB * mW;
    }
    if (a < 128) {
      const edgeT = 1 - smoothstep01(a / 128);
      const eh = rgb8ToHsl(colR, colG, colB);
      const sat = Math.max(0, eh.s * (1 - 0.38 * edgeT));
      const ergb = hslToRgb8(eh.h, sat, eh.l);
      colR = ergb.r;
      colG = ergb.g;
      colB = ergb.b;
    }
    /**
     * **High-α silhouette fringe:** `edgeBand` fades out when `a` is solid, but matting can still be dark + tinted.
     * Use cached mask gradient (same cue as prep rim) to desaturate and pull toward white on catalog backdrops.
     */
    if (pureBg) {
      const gmh = maskEdgeGrad[i];
      if (gmh >= 18 && a >= 72 && srcLum < 148 && srcLum > 12) {
        const edgeCue = smoothstep01((gmh - 14) / 86);
        const darkCue = 1 - smoothstep01((srcLum - 34) / 106);
        const highAFringe = smoothstep01((a - 132) / 98);
        const vivid = smoothstep01((srcChroma - 32) / 54);
        let matting = edgeCue * darkCue * (0.38 + 0.62 * highAFringe);
        matting *= 1 - 0.38 * vivid;
        if (matting > 0.02) {
          const ehM = rgb8ToHsl(colR, colG, colB);
          const satM = Math.max(0, ehM.s * (1 - 0.86 * matting));
          const rgbM = hslToRgb8(ehM.h, satM, ehM.l);
          const bgPullM =
            0.64 *
            matting *
            (0.45 + 0.55 * smoothstep01((a - 152) / 88));
          colR = Math.round(rgbM.r * (1 - bgPullM) + bgR * bgPullM);
          colG = Math.round(rgbM.g * (1 - bgPullM) + bgG * bgPullM);
          colB = Math.round(rgbM.b * (1 - bgPullM) + bgB * bgPullM);
        }
      }
    }
    /**
     * Protected edge band:
     * tint is restricted to core; border pixels are decontaminated toward source luminance + background.
     */
    const edgeBand = 1 - smoothstep01((a - 108) / 116);
    if (edgeBand > 0.001) {
      const srcEdgeH = rgb8ToHsl(sr, sg, sb);
      const edgeSat = Math.max(0, srcEdgeH.s * (1 - 0.9 * edgeBand));
      const edgeRgb = hslToRgb8(srcEdgeH.h, edgeSat, srcEdgeH.l);
      let edgeBgPull = Math.min(0.96, 0.54 + 0.42 * edgeBand);
      if (pureBg && maskEdgeGrad[i] >= 20 && srcLum < 136) {
        edgeBgPull = Math.min(
          0.99,
          edgeBgPull + 0.2 * smoothstep01((maskEdgeGrad[i] - 20) / 82)
        );
      }
      const edgeR = edgeRgb.r * (1 - edgeBgPull) + bgR * edgeBgPull;
      const edgeG = edgeRgb.g * (1 - edgeBgPull) + bgG * edgeBgPull;
      const edgeB = edgeRgb.b * (1 - edgeBgPull) + bgB * edgeBgPull;
      const coreW = 1 - edgeBand;
      colR = colR * coreW + edgeR * edgeBand;
      colG = colG * coreW + edgeG * edgeBand;
      colB = colB * coreW + edgeB * edgeBand;
    }

    /**
     * **After swatch is applied:** matting often reads as **dark tinted** RGB even when neutral `srcLum` was only
     * mid-gray — keyed on **output** luminance + silhouette so the “cord” is flattened toward #fff last.
     */
    if (pureBg) {
      const gmh = maskEdgeGrad[i];
      const colLum = luminanceRgb(colR, colG, colB);
      const nmx = neutralMaxNeighL[i];
      const lumGapN = nmx - srcLum;
      const contactShadowMatte =
        nmx >= 246 &&
        lumGapN > 72 &&
        srcLum < 108 &&
        srcChroma < 34 &&
        gmh >= 11
          ? smoothstep01((nmx - 243) / 10) *
            smoothstep01((lumGapN - 58) / 88) *
            smoothstep01((108 - srcLum) / 88) *
            smoothstep01((34 - srcChroma) / 28) *
            smoothstep01((gmh - 9) / 78)
          : 0;
      let postTintKill =
        smoothstep01((gmh - 6) / 92) *
        (1 - smoothstep01((colLum - 38) / 82)) *
        smoothstep01((a - 48) / 168) *
        (1 - 0.42 * smoothstep01((srcChroma - 56) / 42));
      postTintKill = Math.min(1, postTintKill + 0.32 * contactShadowMatte);
      if (postTintKill > 0.055 && colLum < 122) {
        const k = Math.min(
          0.72,
          0.28 + 0.48 * postTintKill * (1 - smoothstep01((colLum - 28) / 75))
        );
        colR = Math.round(colR * (1 - k) + bgR * k);
        colG = Math.round(colG * (1 - k) + bgG * k);
        colB = Math.round(colB * (1 - k) + bgB * k);
      }
    }

    let aComp = a;
    if (pureBg && maskEdgeGrad[i] >= 14 && a < 36) {
      const nmax = alphaNeighborMax[i];
      if (nmax > a + 8) {
        aComp = Math.min(252, Math.max(a, nmax - 16));
      }
    }
    let af = aComp / 255;
    /**
     * **Composite α defringe (catalog white):** dark matting often keeps high mask α; lowering effective coverage
     * at the silhouette lets more backdrop through — complements RGB decontam without another full prep pass.
     */
    if (pureBg) {
      const gmh = maskEdgeGrad[i];
      if (gmh >= 20 && a >= 40 && a <= 252 && srcLum < 142 && srcLum > 12) {
        let aPull =
          smoothstep01((gmh - 16) / 84) *
          (1 - smoothstep01((srcLum - 30) / 108)) *
          (0.22 + 0.78 * smoothstep01((a - 92) / 132));
        if (a < 52) {
          aPull *= 0.28 + 0.72 * smoothstep01((a - 28) / 24);
        }
        const vividGuard = 1 - 0.48 * smoothstep01((srcChroma - 48) / 44);
        af *= 1 - 0.42 * aPull * vividGuard;
      }
      const colLum2 = luminanceRgb(colR, colG, colB);
      if (
        colLum2 < 98 &&
        maskEdgeGrad[i] >= 18 &&
        a >= 100 &&
        srcChroma < 42
      ) {
        const aPull2 =
          smoothstep01((maskEdgeGrad[i] - 14) / 82) *
          (1 - smoothstep01((colLum2 - 28) / 72)) *
          smoothstep01((a - 108) / 118);
        af *= 1 - 0.14 * aPull2;
      }
      if (a < 40 && gmh >= 16) {
        const floorAf = Math.max(
          a / 255,
          Math.min(1, (Math.max(a, alphaNeighborMax[i] - 22) / 255) * 0.92)
        );
        af = Math.max(af, floorAf);
      }
    }
    dd[o] = Math.round(colR * af + bgR * (1 - af));
    dd[o + 1] = Math.round(colG * af + bgG * (1 - af));
    dd[o + 2] = Math.round(colB * af + bgB * (1 - af));
    dd[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Linear sRGB multiply inside the mask: C_out = C_base × C_tint (per channel, linear light).
 * Preserves stitching, weave, folds, and shadow gradients from the source capture — natural “dye”, not a flat overlay.
 * Intended for **white or light neutral** garments; colored bases will shift hue incorrectly (use LAB instead).
 */
function applyMaskedMultiplyRecolor(
  ctx,
  w,
  h,
  garmentHex,
  maskNatCanvas,
  sceneHex,
  baseImage
) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(baseImage, 0, 0, w, h);
  const src = tctx.getImageData(0, 0, w, h);
  const sd = src.data;

  const { r: tr0, g: tg0, b: tb0 } = parseHexRgb(garmentHex);
  const pureBg = state.pureWhiteProductMode;
  const { r: bgR0, g: bgG0, b: bgB0 } = parseHexRgb(sceneHex);
  const bgR = pureBg ? 255 : bgR0;
  const bgG = pureBg ? 255 : bgG0;
  const bgB = pureBg ? 255 : bgB0;

  const labT = srgb8RgbToLab(tr0, tg0, tb0);
  const muted = labToSrgb8(labT.L, labT.a * 0.9, labT.b * 0.9);
  const rt = linearFromSrgb8(muted.r);
  const gt = linearFromSrgb8(muted.g);
  const bt = linearFromSrgb8(muted.b);

  const maskAlpha = getMaskAlphaPlaneScaled(maskNatCanvas, w, h);
  const n = w * h;
  const img = ctx.getImageData(0, 0, w, h);
  const dd = img.data;

  for (let i = 0; i < n; i++) {
    const a = maskAlpha[i];
    if (a < 2) continue;
    /**
     * Preserve soft highlight/fold alpha on white backgrounds; avoid clipped shoulder regions.
     */
    if (pureBg && a < 6) continue;
    const o = i * 4;

    const br = sd[o];
    const bg = sd[o + 1];
    const bb = sd[o + 2];

    let rl = linearFromSrgb8(br) * rt;
    let gl = linearFromSrgb8(bg) * gt;
    let bl = linearFromSrgb8(bb) * bt;
    rl = Math.max(0, Math.min(1, rl));
    gl = Math.max(0, Math.min(1, gl));
    bl = Math.max(0, Math.min(1, bl));
    let or = srgb8ChannelFromLinear(rl);
    let og = srgb8ChannelFromLinear(gl);
    let ob = srgb8ChannelFromLinear(bl);

    let eb = pureBg
      ? 1 - smoothstep01((a - 30) / 2.8)
      : 1 - smoothstep01((a - 3) / 52);
    if (pureBg && a < 112) {
      const lumG = luminanceRgb(or, og, ob);
      if (lumG < 182) {
        const darkOuter =
          (1 - smoothstep01((a - 28) / 84)) *
          (1 - smoothstep01((lumG - 88) / 94));
        eb = Math.min(1, eb + 0.88 * darkOuter);
      }
    }
    const ebFr = pureBg ? attenuatePureWhiteFringeEb(or, og, ob, eb) : eb;
    /**
     * Multiply + L*→100 double-lightens rim highlights. Use a tight quadratic RGB mix only (after attenuation).
     */
    if (pureBg && ebFr > 0.0005) {
      const k = ebFr * ebFr;
      or = Math.round(or * (1 - k) + bgR * k);
      og = Math.round(og * (1 - k) + bgG * k);
      ob = Math.round(ob * (1 - k) + bgB * k);
    } else {
      or = Math.round(or * (1 - ebFr) + bgR * ebFr);
      og = Math.round(og * (1 - ebFr) + bgG * ebFr);
      ob = Math.round(ob * (1 - ebFr) + bgB * ebFr);
    }
    dd[o] = or;
    dd[o + 1] = og;
    dd[o + 2] = ob;
    dd[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Shrink mask support (min alpha in 5×5) so tint does not ride soft mask + JPEG fringe into the backdrop.
 */
/** Max alpha in 3×3 — weak pixels surrounded by solid garment stay tinted (fixes cuff/hem “white specks”). */
function computeAlphaNeighborMax(alpha, w, h) {
  const n = w * h;
  const out = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const a = alpha[ny * w + nx];
          if (a > m) m = a;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** Max linear Y (relative luminance) in 3×3 — lifts k when a pixel is a local shadow between brighter fabric samples. */
function computeLuminanceNeighborMaxLinear(bd, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ym = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const o = (ny * w + nx) * 4;
          const lr = linearFromSrgb8(bd[o]);
          const lg = linearFromSrgb8(bd[o + 1]);
          const lb = linearFromSrgb8(bd[o + 2]);
          const yy = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
          if (yy > ym) ym = yy;
        }
      }
      out[y * w + x] = ym;
    }
  }
  return out;
}

/** Morphological close on garment α (fill pinholes) — avoids open that can erase 1px drawstrings. */
function morphCloseAlphaCatalog(alpha, w, h) {
  let a = dilateAlphaPlaneUint8(alpha, w, h, 1);
  a = erodeAlphaPlaneUint8(a, w, h, 1);
  return a;
}

/**
 * Clean + feather mask, suppress near-white backdrop leaks, expose soft weights for LAB-only enhancement.
 * Light dilate after close helps pocket / cuff coverage; extra Gaussian passes soften edges (less halo).
 */
function buildCatalogEnhanceMaskFields(rawMaskAlpha, w, h, rgbaData) {
  const n = w * h;
  let aMorph = morphCloseAlphaCatalog(rawMaskAlpha, w, h);
  aMorph = dilateAlphaPlaneUint8(aMorph, w, h, 1);
  aMorph = blurAlphaPlaneGaussian3(aMorph, w, h, 3);
  const wEnh = new Float32Array(n);
  for (let i = 0; i < n; i++) wEnh[i] = aMorph[i] / 255;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lab = srgb8RgbToLab(rgbaData[o], rgbaData[o + 1], rgbaData[o + 2]);
    const lum8 = luminanceRgb(rgbaData[o], rgbaData[o + 1], rgbaData[o + 2]);
    const cab = Math.hypot(lab.a, lab.b);
    if (lum8 >= 251 && lab.L >= 98.2 && cab < 6.2) {
      wEnh[i] *= 0.06;
    } else if (lum8 >= 249 && lab.L >= 97.5 && cab < 7.5 && wEnh[i] < 0.55) {
      wEnh[i] *= 0.32;
    } else if (lum8 >= 247 && lab.L >= 96.8 && cab < 9 && wEnh[i] < 0.38) {
      wEnh[i] *= 0.48;
    }
  }
  const aNeighU8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    aNeighU8[i] = Math.round(Math.min(255, Math.max(0, wEnh[i] * 255)));
  }
  const aNeigh = computeAlphaNeighborMax(aNeighU8, w, h);
  const mGrad = computeMaskAlphaGradientMax(aNeighU8, w, h, 1);
  return { wEnh, aNeigh, mGrad, maskBlurAlpha: aMorph };
}

function catalogHistPercentileWeighted(hist, total, q) {
  const target = Math.max(1, Math.min(total - 1, (q * total) | 0));
  let c = 0;
  for (let b = 0; b <= 100; b++) {
    c += hist[b];
    if (c >= target) return b;
  }
  return 100;
}

/**
 * Contrast-limited adaptive histogram (LAB L\*) on a coarse grid, garment-weighted; output is ΔL to blend.
 * Identity is pulled in below the garment’s L08 (jet-black guard).
 */
function precomputeClaheLabLDelta(Lplane, wEnh, w, h, preset, profile) {
  const n = w * h;
  const delta = new Float32Array(n);
  const tilePx = Math.max(26, Math.min(76, Math.round(Math.min(w, h) / 14)));
  const nx = Math.max(1, Math.ceil(w / tilePx));
  const ny = Math.max(1, Math.ceil(h / tilePx));
  let clipFrac = 0.02;
  let strength = 0.2;
  if (preset === "very_dark_product") {
    clipFrac = 0.04;
    strength = 0.48;
  } else if (preset === "dark_product") {
    clipFrac = 0.034;
    strength = 0.39;
  } else if (preset === "light_product") {
    clipFrac = 0.012;
    strength = 0.085;
  } else if (preset === "saturated_color_product") {
    clipFrac = 0.019;
    strength = 0.16;
  }
  const spanDeepGuard = Math.max(0.45, profile.L06 - profile.L02 + 0.06);
  const deepDamp = (Lin) =>
    smoothstep01((Lin - profile.L02 - 0.05) / spanDeepGuard);
  const tileCount = nx * ny;
  const tileLuts = new Float32Array(tileCount * 101);

  for (let ty = 0; ty < ny; ty++) {
    for (let tx = 0; tx < nx; tx++) {
      const hist = new Uint32Array(101);
      let sumW = 0;
      const x0 = tx * tilePx;
      const x1 = Math.min(w, (tx + 1) * tilePx);
      const y0 = ty * tilePx;
      const y1 = Math.min(h, (ty + 1) * tilePx);
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          const wt = wEnh[i];
          if (wt < 0.055) continue;
          const bi = Math.max(0, Math.min(100, Math.round(Lplane[i])));
          const wi = (wt * 850) | 0;
          hist[bi] += wi;
          sumW += wi;
        }
      }
      const ti = ty * nx + tx;
      const base = ti * 101;
      if (sumW < 380) {
        for (let k = 0; k <= 100; k++) tileLuts[base + k] = k;
        continue;
      }
      const lim = Math.max(96, (sumW * clipFrac) | 0);
      let excess = 0;
      for (let b = 0; b <= 100; b++) {
        if (hist[b] > lim) {
          excess += hist[b] - lim;
          hist[b] = lim;
        }
      }
      const add = (excess / 101) | 0;
      for (let b = 0; b <= 100; b++) hist[b] += add;
      const cdf = new Uint32Array(102);
      for (let b = 0; b <= 100; b++) cdf[b + 1] = cdf[b] + hist[b];
      const tot = cdf[101];
      const pLo = catalogHistPercentileWeighted(hist, tot, 0.04);
      const pHi = Math.max(pLo + 1, catalogHistPercentileWeighted(hist, tot, 0.96));
      for (let Lin = 0; Lin <= 100; Lin++) {
        const f = tot > 0 ? cdf[Lin + 1] / tot : Lin / 100;
        let Lmap = pLo + f * (pHi - pLo);
        if (preset === "very_dark_product" || preset === "dark_product") {
          const id = deepDamp(Lin);
          Lmap = Lin + (Lmap - Lin) * id;
        }
        tileLuts[base + Lin] = Lmap;
      }
    }
  }

  const sampleLut = (tix, tiy, Lv) => {
    const ti = Math.max(0, Math.min(tileCount - 1, tiy * nx + tix));
    const lb = ti * 101;
    const lf = Math.max(0, Math.min(100, Lv));
    const i0 = lf | 0;
    const fr = lf - i0;
    const i1 = Math.min(100, i0 + 1);
    return tileLuts[lb + i0] * (1 - fr) + tileLuts[lb + i1] * fr;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const wt = wEnh[i];
      if (wt < 0.045) continue;
      const L0 = Lplane[i];
      const txf = (x + 0.5) / tilePx;
      const tyf = (y + 0.5) / tilePx;
      const tix0 = Math.max(0, Math.min(nx - 1, txf | 0));
      const tiy0 = Math.max(0, Math.min(ny - 1, tyf | 0));
      const tix1 = Math.min(nx - 1, tix0 + 1);
      const tiy1 = Math.min(ny - 1, tiy0 + 1);
      const ax = txf - tix0;
      const ay = tyf - tiy0;
      const v00 = sampleLut(tix0, tiy0, L0);
      const v10 = sampleLut(tix1, tiy0, L0);
      const v01 = sampleLut(tix0, tiy1, L0);
      const v11 = sampleLut(tix1, tiy1, L0);
      const v0 = v00 * (1 - ax) + v10 * ax;
      const v1 = v01 * (1 - ax) + v11 * ax;
      const Lmap = v0 * (1 - ay) + v1 * ay;
      let dlt = (Lmap - L0) * strength;
      if (preset === "very_dark_product") dlt = Math.max(-2.35, Math.min(6.95, dlt));
      else if (preset === "dark_product") dlt = Math.max(-2.75, Math.min(5.55, dlt));
      else if (preset === "light_product") dlt = Math.max(-1.6, Math.min(2.4, dlt));
      else dlt = Math.max(-2.85, Math.min(4.35, dlt));
      if (preset === "very_dark_product" || profile.jetNeutral) {
        const abyss = 1 - smoothstep01((L0 - profile.L02 - 0.06) / Math.max(0.35, profile.L05 - profile.L02));
        dlt *= 0.12 + 0.88 * (1 - abyss * 0.92);
      }
      delta[i] = dlt * smoothstep01((wt - 0.035) / 0.92);
    }
  }
  return delta;
}

/** |∇L\*| for edge-aware sharpening (folds, pocket, ribbing). */
function computeLabLGradientMax(Lplane, w, h) {
  const n = w * h;
  const g = new Float32Array(n);
  const wm = w - 1;
  const hm = h - 1;
  for (let y = 1; y < hm; y++) {
    const row = y * w;
    for (let x = 1; x < wm; x++) {
      const i = row + x;
      const sx = (Lplane[i + 1] - Lplane[i - 1]) * 0.5;
      const sy = (Lplane[i + w] - Lplane[i - w]) * 0.5;
      g[i] = Math.hypot(sx, sy);
    }
  }
  return g;
}

/** |∇²L\*| (discrete Laplacian magnitude) — cord / pocket lip / seam-line cue on luminance only. */
function computeLabLLaplacianAbs(Lplane, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      out[i] = Math.abs(
        4 * Lplane[i] -
          Lplane[i - 1] -
          Lplane[i + 1] -
          Lplane[i - w] -
          Lplane[i + w]
      );
    }
  }
  return out;
}

/**
 * Histogram-percentile dark-mid separation (LAB L\*): ~0–6% unchanged, gentle 6–15%, stronger 15–~50%.
 * Uses `gateDetail` so folds/pocket/drawstrings recover without lifting the flattest black mass evenly.
 */
function catalogDarkMidCurveDelta(L0, profile, preset, dL, gateDetail) {
  if (preset !== "very_dark_product" && preset !== "dark_product") return 0;
  if (L0 < profile.L06 - 0.02) return 0;
  const span615 = Math.max(0.38, profile.L15 - profile.L06);
  const u615 = Math.max(0, Math.min(1, (L0 - profile.L06) / span615));
  const band615 =
    smoothstep01((u615 - 0.015) / 0.175) *
    (1 - smoothstep01((u615 - 0.91) / 0.2));
  const span1552 = Math.max(0.58, profile.L52 - profile.L15);
  const u1552 = Math.max(0, Math.min(1, (L0 - profile.L15) / span1552));
  const band1552 =
    smoothstep01((u1552 - 0.01) / 0.14) *
    (1 - smoothstep01((u1552 - 0.93) / 0.2));
  const isVd = preset === "very_dark_product" || profile.jetNeutral;
  const kBase = isVd ? 0.182 : 0.118;
  const w615 = isVd ? 0.66 : 0.56;
  const w1552 = isVd ? 1.82 : 1.5;
  const notAbyss = smoothstep01(
    (L0 - profile.L02 - 0.06) / Math.max(0.28, profile.L06 - profile.L02)
  );
  return kBase * gateDetail * dL * notAbyss * (band615 * w615 + band1552 * w1552);
}

/**
 * Thin-structure cue on LAB L\*: mid-strength |∇L\*| (pocket / drawstrings / seams), down-weighted on mask rim.
 */
function catalogThinStructureWeight(lGrad, mGrad, we) {
  const g = lGrad;
  const thinW =
    smoothstep01((g - 0.11) / 1.72) *
    (1 - smoothstep01((g - 9.8) / 5.2));
  const rim = 1 - 0.55 * smoothstep01((mGrad - 42) / 74);
  const core = smoothstep01((we - 0.12) / 0.76);
  return Math.max(0, Math.min(1, thinW * rim * core));
}

/**
 * LAB L* histogram on garment (scaled mask) for adaptive catalog enhancement — percentiles are robust to outliers.
 */
function sampleCatalogGarmentLabTone(d, maskA, w, h) {
  const n = w * h;
  const histL = new Uint32Array(101);
  let cabSum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (maskA[i] < 58) continue;
    const o = i * 4;
    const lab = srgb8RgbToLab(d[o], d[o + 1], d[o + 2]);
    const b = Math.max(0, Math.min(100, Math.round(lab.L)));
    histL[b]++;
    cabSum += Math.hypot(lab.a, lab.b);
    count++;
  }
  if (count < 80) return null;
  const pct = (q) => {
    const target = Math.max(1, Math.min(count - 1, q * count));
    let cum = 0;
    for (let L = 0; L <= 100; L++) {
      cum += histL[L];
      if (cum >= target) return L;
    }
    return 100;
  };
  const L02 = pct(0.02);
  const L05 = pct(0.05);
  const L06 = pct(0.06);
  const L08 = pct(0.08);
  const L10 = pct(0.1);
  const L12 = pct(0.12);
  const L15 = pct(0.15);
  const L18 = pct(0.18);
  const L22 = pct(0.22);
  const L35 = pct(0.35);
  const L45 = pct(0.45);
  const L50 = pct(0.5);
  const L52 = pct(0.52);
  const L92 = pct(0.92);
  const L95 = pct(0.95);
  const meanCab = cabSum / count;
  const jetNeutral = L50 < 30.5 && meanCab < 18.5;
  const lightGarment = L50 > 76;
  const saturated = meanCab > 33;
  const darkGarment = L50 < 44 && !lightGarment;
  const veryDarkGarment = L50 < 24 && meanCab < 20;
  const saturatedColor =
    saturated &&
    meanCab > 28.5 &&
    !jetNeutral &&
    !lightGarment &&
    !veryDarkGarment &&
    !(darkGarment && L50 < 34) &&
    L50 >= 24 &&
    L50 <= 74;
  let enhancePreset = "midtone_product";
  if (lightGarment) enhancePreset = "light_product";
  else if (jetNeutral) enhancePreset = "very_dark_product";
  else if (veryDarkGarment || (darkGarment && L50 < 30))
    enhancePreset = "very_dark_product";
  else if (darkGarment) enhancePreset = "dark_product";
  else if (saturatedColor) enhancePreset = "saturated_color_product";
  return {
    L02,
    L05,
    L06,
    L08,
    L10,
    L12,
    L15,
    L18,
    L22,
    L35,
    L45,
    L50,
    L52,
    L92,
    L95,
    meanCab,
    count,
    jetNeutral,
    lightGarment,
    saturated,
    saturatedColor,
    darkGarment,
    veryDarkGarment,
    enhancePreset,
  };
}

/**
 * Adaptive, color-preserving catalog enhancement: garment mask (morph + feather + white-backdrop guard), LAB L\*
 * only (fixed a\*,b\*), percentile-based product class, CLAHE-style tile equalization on L\*, multi-scale local
 * contrast, ridge/valley, soft UL fill, edge-aware unsharp — all masked; background restored from source where
 * weight is negligible. No global brightness lift.
 */
function applyCatalogEnhanceSafetyPass(
  d,
  orig,
  wEnh,
  w,
  h,
  profile,
  preset,
  br,
  bg,
  bb
) {
  const n = w * h;
  const jetLike =
    preset === "very_dark_product" ||
    profile.jetNeutral ||
    preset === "dark_product";
  const pureBg = luminanceRgb(br, bg, bb) >= 248;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const we = wEnh[i];
    if (pureBg && we < 0.046) {
      d[o] = orig[o];
      d[o + 1] = orig[o + 1];
      d[o + 2] = orig[o + 2];
      continue;
    }
    if (!jetLike || we < 0.058) continue;
    const labN = srgb8RgbToLab(d[o], d[o + 1], d[o + 2]);
    const labO = srgb8RgbToLab(orig[o], orig[o + 1], orig[o + 2]);
    if (
      labO.L < profile.L06 + 0.35 &&
      labN.L > labO.L + 1.55 &&
      labO.L < profile.L05 + 0.62
    ) {
      const excess = labN.L - labO.L - 1.55;
      const Lpull = labN.L - excess * (0.42 + 0.26 * smoothstep01(excess / 3.2));
      const out = labToSrgb8(Lpull, labN.a, labN.b);
      d[o] = out.r;
      d[o + 1] = out.g;
      d[o + 2] = out.b;
      continue;
    }
    if (labO.L < profile.L05 + 0.52 && labN.L > labO.L + 2.28) {
      const excess = labN.L - labO.L - 2.28;
      const Lpull = labN.L - excess * (0.4 + 0.24 * smoothstep01(excess / 3.5));
      const out = labToSrgb8(Lpull, labN.a, labN.b);
      d[o] = out.r;
      d[o + 1] = out.g;
      d[o + 2] = out.b;
    }
  }
}

/** Studio-white catalog: force backdrop to #fff where garment weight has fallen off (post-enhance). */
function catalogRestorePureWhiteBackdrop(d, wEnh, w, h, br, bg, bb) {
  if (luminanceRgb(br, bg, bb) < 247) return;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (wEnh[i] > 0.052) continue;
    const o = i * 4;
    d[o] = 255;
    d[o + 1] = 255;
    d[o + 2] = 255;
  }
}

function applyCatalogProductEnhance(ctx, w, h, maskNatCanvas, sceneHex, garmentHex) {
  const { r: br, g: bg, b: bb } = parseHexRgb(sceneHex);
  if (luminanceRgb(br, bg, bb) < 240) return;
  const rawMask = getMaskAlphaPlaneScaled(maskNatCanvas, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const orig = new Uint8ClampedArray(d);
  const n = w * h;
  const wm = Math.max(1, w - 1);
  const hm = Math.max(1, h - 1);

  let profile = sampleCatalogGarmentLabTone(d, rawMask, w, h);
  if (!profile) return;

  const { wEnh, aNeigh, mGrad, maskBlurAlpha } = buildCatalogEnhanceMaskFields(
    rawMask,
    w,
    h,
    d
  );

  if (garmentHex) {
    const { r: gr, g: gg, b: gb } = parseHexRgb(garmentHex);
    const hint = srgb8RgbToLab(gr, gg, gb);
    const hintJet = hint.L < 30 && Math.hypot(hint.a, hint.b) < 18;
    if (hintJet && profile.L50 < 42) {
      profile = {
        ...profile,
        jetNeutral: true,
        enhancePreset: "very_dark_product",
      };
    }
  }
  const preset = profile.enhancePreset;
  const satMul = profile.saturated ? 0.88 : 1;

  const Lplane = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lab = srgb8RgbToLab(d[o], d[o + 1], d[o + 2]);
    Lplane[i] = lab.L;
  }

  const claheD = precomputeClaheLabLDelta(Lplane, wEnh, w, h, preset, profile);
  const lGrad = computeLabLGradientMax(Lplane, w, h);
  const lLap = computeLabLLaplacianAbs(Lplane, w, h);

  const minM = 36;
  const r1 = Math.max(1, Math.min(3, Math.round(Math.min(w, h) / 420)));
  const r2 = Math.min(3, r1 + 1);
  const r3 = Math.min(3, r1 + 2);
  const rW = Math.min(4, Math.max(2, Math.round(Math.min(w, h) / 300)));
  const Lb1 = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, r1, minM);
  const Lb2 = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, r2, minM);
  const Lb3 = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, r3, minM);
  const LbW = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, rW, minM);
  const LbFine = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, 1, 28);
  const Lb2px = boxBlurFloat2DSeparateMasked(Lplane, maskBlurAlpha, w, h, 2, 30);

  let clarity = 0.2;
  let midtoneBoost = 0;
  let ridgePos = 0.14;
  let ridgeNeg = 0.05;
  let kDir = 0.12;
  let usmK = 0.048;
  let bpOff = 0;
  let bpDiv = 6.2;
  let fineK = 0.055;
  let lumaCap = 8.2;
  let claheMix = 0.64;
  let ulBoost = 1;
  let thinK = 0;
  let hpBlend = 0;
  let chestK = 0;
  let lapK = 0;
  if (preset === "very_dark_product") {
    clarity = 0.278;
    midtoneBoost = 0.118;
    ridgePos = 0.418;
    ridgeNeg = 0.145;
    kDir = 0.64;
    usmK = 0.148;
    bpOff = 0.72;
    bpDiv = Math.max(6.2, (profile.L95 - profile.L05) * 0.1);
    fineK = 0.192;
    lumaCap = 9.05;
    claheMix = 0.64;
    ulBoost = 1.1;
    thinK = 0.168;
    hpBlend = 0.292;
    chestK = 0.072;
    lapK = 0.069;
  } else if (preset === "dark_product") {
    clarity = 0.256;
    midtoneBoost = 0.1;
    ridgePos = 0.278;
    ridgeNeg = 0.104;
    kDir = 0.38;
    usmK = 0.102;
    bpOff = 0.24;
    bpDiv = 4.35;
    fineK = 0.138;
    lumaCap = 8.45;
    claheMix = 0.65;
    ulBoost = 1.07;
    thinK = 0.124;
    hpBlend = 0.225;
    chestK = 0.052;
    lapK = 0.05;
  } else if (preset === "light_product") {
    clarity = 0.112;
    midtoneBoost = 0.028;
    ridgePos = 0.074;
    ridgeNeg = 0.028;
    kDir = 0.068;
    usmK = 0.034;
    bpOff = 0;
    bpDiv = 1;
    fineK = 0.032;
    lumaCap = 5.2;
    claheMix = 0.56;
    ulBoost = 1;
    thinK = 0.022;
    hpBlend = 0.038;
    chestK = 0.012;
    lapK = 0;
  } else if (preset === "saturated_color_product") {
    clarity = 0.178;
    midtoneBoost = 0.058;
    ridgePos = 0.115;
    ridgeNeg = 0.044;
    kDir = 0.136;
    usmK = 0.048;
    bpOff = 0;
    bpDiv = 1;
    fineK = 0.068;
    lumaCap = 7;
    claheMix = 0.66;
    ulBoost = 1.04;
    thinK = 0.038;
    hpBlend = 0.055;
    chestK = 0.018;
    lapK = 0.018;
  } else {
    clarity = 0.208;
    midtoneBoost = 0.054;
    ridgePos = 0.122;
    ridgeNeg = 0.046;
    kDir = 0.155;
    usmK = 0.052;
    bpOff = 0;
    bpDiv = 1;
    fineK = 0.076;
    lumaCap = 7.6;
    claheMix = 0.64;
    ulBoost = 1.05;
    thinK = 0.048;
    hpBlend = 0.072;
    chestK = 0.024;
    lapK = 0.024;
  }
  clarity *= satMul;
  midtoneBoost *= satMul;
  ridgePos *= satMul;
  ridgeNeg *= satMul;
  kDir *= satMul;
  usmK *= satMul;
  fineK *= satMul;
  thinK *= satMul;
  hpBlend *= satMul;
  chestK *= satMul;
  lapK *= satMul;

  const lSpan = Math.max(2.2, profile.L95 - profile.L05);
  const span8135 = Math.max(0.65, profile.L35 - profile.L08);
  const spanDeep = Math.max(0.45, profile.L08 - profile.L05);
  const span1045 = Math.max(1.1, profile.L45 - profile.L10);
  const span1845 = Math.max(0.55, profile.L52 - profile.L18);
  const span1252 = Math.max(0.5, profile.L52 - profile.L12);
  const hiCap = profile.lightGarment ? profile.L95 + 2.62 : profile.L95 + 3.85;
  const edgeMix = 0.952;
  const gRef =
    preset === "very_dark_product"
      ? 4.35
      : preset === "dark_product"
        ? 3.95
        : 3.2;

  for (let i = 0; i < n; i++) {
    const we = wEnh[i];
    if (we < 0.028) continue;
    const an = aNeigh[i] / 255;
    if (an < 0.07) continue;
    const edgeW =
      smoothstep01((we - 0.03) / 0.9) * smoothstep01((an - 0.065) / 0.9);
    if (edgeW < 0.032) continue;
    const maU8 = Math.round(Math.min(255, we * 255));
    const haloReduce =
      1 -
      0.6 *
        smoothstep01((mGrad[i] - 12) / 84) *
        smoothstep01((120 - maU8) / 108);
    const o = i * 4;
    const lab0 = srgb8RgbToLab(d[o], d[o + 1], d[o + 2]);
    const L0 = lab0.L;
    const dLf = L0 - Lb1[i];
    const dLm = L0 - Lb2[i];
    const dLw = L0 - Lb3[i];
    const dFine = L0 - LbFine[i];
    const dTex = L0 - Lb2px[i];
    const dL = 0.38 * dLf + 0.34 * dLm + 0.28 * dLw;
    let deepGate = 1;
    if (preset === "very_dark_product" || preset === "dark_product") {
      deepGate = smoothstep01((L0 - profile.L05 - 0.12) / spanDeep);
    }
    let bpActive = 1;
    if (bpDiv >= 1.45) {
      bpActive = smoothstep01((L0 - profile.L05 - bpOff) / bpDiv);
    }
    const gate = deepGate * bpActive * haloReduce;
    const gateDetail =
      haloReduce *
      smoothstep01(
        (L0 - profile.L06) / Math.max(0.32, profile.L52 - profile.L06)
      ) *
      (0.38 + 0.62 * bpActive);
    const structureGate =
      preset === "very_dark_product" || preset === "dark_product"
        ? Math.min(
            1,
            gate +
              gateDetail *
                0.38 *
                smoothstep01(
                  (L0 - profile.L10) / Math.max(0.42, profile.L52 - profile.L10)
                )
          )
        : gate;
    const xi = i % w;
    const yi = (i / w) | 0;
    const yNorm = yi / hm;
    const xRel = (xi + 0.5) / wm;
    const lowGradPanel = 1 - smoothstep01((lGrad[i] - 0.14) / 0.58);
    const upperChestOnly =
      smoothstep01((yNorm - 0.09) / 0.15) *
      (1 - smoothstep01((yNorm - 0.36) / 0.17));
    const pocketBandY =
      smoothstep01((yNorm - 0.33) / 0.12) *
      (1 - smoothstep01((yNorm - 0.81) / 0.14));
    const flatMassCore =
      upperChestOnly *
      lowGradPanel *
      smoothstep01((L0 - profile.L06) / Math.max(0.3, profile.L18 - profile.L06 + 0.08)) *
      (1 - smoothstep01((L0 - profile.L22) / Math.max(0.38, profile.L35 - profile.L22))) *
      smoothstep01((we - 0.17) / 0.68);
    const flatMass =
      flatMassCore * (1 - 0.78 * pocketBandY) * smoothstep01((we - 0.14) / 0.72);
    const flatDamp =
      preset === "very_dark_product" || profile.jetNeutral
        ? 0.54
        : preset === "dark_product"
          ? 0.4
          : 0;
    const flatSuppress = 1 - flatDamp * flatMass;
    const hoodStruct =
      smoothstep01((yNorm - 0.02) / 0.13) *
      (1 - smoothstep01((yNorm - 0.38) / 0.15)) *
      smoothstep01((lGrad[i] - 0.18) / 2.5) *
      (1 - smoothstep01((lGrad[i] - 8.8) / 4.8));
    const pocketStruct = pocketBandY * (0.55 + 0.45 * smoothstep01(lGrad[i] / 3.2));
    const pocketSides =
      pocketBandY *
      smoothstep01((Math.abs(xRel - 0.5) - 0.12) / 0.17) *
      (1 - smoothstep01((Math.abs(xRel - 0.5) - 0.46) / 0.11));
    const pocketLeftOpen =
      pocketBandY *
      smoothstep01((0.17 - Math.abs(xRel - 0.302)) / 0.09) *
      (0.62 + 0.38 * smoothstep01(lGrad[i] / 2.75));
    const pocketRightOpen =
      pocketBandY *
      smoothstep01((0.17 - Math.abs(xRel - 0.698)) / 0.09) *
      (0.62 + 0.38 * smoothstep01(lGrad[i] / 2.75));
    const pocketOpenings = Math.max(pocketLeftOpen, pocketRightOpen);
    const pocketBottom =
      pocketBandY *
      smoothstep01((yNorm - 0.48) / 0.095) *
      (1 - smoothstep01((yNorm - 0.71) / 0.14)) *
      (1 - smoothstep01((Math.abs(xRel - 0.5) - 0.3) / 0.16));
    const hemRib =
      smoothstep01((yNorm - 0.818) / 0.09) *
      (1 - smoothstep01((yNorm - 0.996) / 0.018)) *
      (0.55 + 0.45 * smoothstep01(lGrad[i] / 2.4));
    const sleeveCuff =
      smoothstep01((yNorm - 0.5) / 0.14) *
      (1 - smoothstep01((yNorm - 0.83) / 0.11)) *
      smoothstep01((Math.abs(xRel - 0.5) - 0.34) / 0.11) *
      (1 - smoothstep01((Math.abs(xRel - 0.5) - 0.49) / 0.075));
    const drawCordZone =
      smoothstep01((yNorm - 0.035) / 0.105) *
      (1 - smoothstep01((yNorm - 0.37) / 0.15)) *
      (1 - smoothstep01((Math.abs(xRel - 0.5) - 0.28) / 0.18));
    const shoulderSeam =
      smoothstep01((yNorm - 0.07) / 0.12) *
      (1 - smoothstep01((yNorm - 0.3) / 0.2)) *
      smoothstep01((Math.abs(xRel - 0.5) - 0.36) / 0.11) *
      (0.42 + 0.58 * smoothstep01(lGrad[i] / 2.65));
    const sleeveFold =
      smoothstep01((yNorm - 0.2) / 0.22) *
      (1 - smoothstep01((yNorm - 0.74) / 0.2)) *
      smoothstep01((Math.abs(xRel - 0.5) - 0.2) / 0.2) *
      (1 - smoothstep01((Math.abs(xRel - 0.5) - 0.44) / 0.13)) *
      (0.38 + 0.62 * smoothstep01(lGrad[i] / 2.35));
    const structDetailMul =
      1 +
      (preset === "very_dark_product" || preset === "dark_product" || profile.jetNeutral
        ? 0.16 * hoodStruct +
          0.12 * pocketStruct +
          0.17 * pocketSides +
          0.32 * pocketOpenings +
          0.26 * pocketBottom +
          0.2 * drawCordZone +
          0.12 * hemRib +
          0.11 * sleeveCuff +
          0.11 * shoulderSeam +
          0.1 * sleeveFold
        : 0);
    let L1 = L0 + clarity * dL * gate * flatSuppress;
    const u8135 = Math.max(0, Math.min(1, (L0 - profile.L08) / span8135));
    const band8135 =
      smoothstep01((u8135 - 0.012) / 0.175) *
      (1 - smoothstep01((u8135 - 0.88) / 0.28));
    const u1045 = Math.max(0, Math.min(1, (L0 - profile.L10) / span1045));
    const band1045 =
      smoothstep01((u1045 - 0.08) / 0.22) *
      (1 - smoothstep01((u1045 - 0.82) / 0.24));
    const ridge = Math.max(0, dLf);
    const valley = Math.min(0, dLf);
    L1 +=
      band8135 *
      (ridgePos * ridge + ridgeNeg * valley) *
      structureGate *
      (0.92 + 0.1 * hoodStruct);
    L1 +=
      band1045 *
      fineK *
      dFine *
      structureGate *
      (0.55 + 0.45 * deepGate) *
      (0.9 + 0.14 * (hoodStruct + pocketStruct));
    if (midtoneBoost > 0.004) {
      const u = Math.max(0, Math.min(1, (L0 - profile.L05) / lSpan));
      const midW =
        smoothstep01((u - 0.035) / 0.19) * (1 - smoothstep01((u - 0.52) / 0.32));
      L1 +=
        midtoneBoost *
        midW *
        dL *
        (0.3 + 0.7 * deepGate) *
        haloReduce *
        flatSuppress;
    }
    L1 +=
      catalogDarkMidCurveDelta(L0, profile, preset, dL, gateDetail) *
      flatSuppress *
      (1 - 0.42 * flatMass * lowGradPanel);
    const interiorCore =
      smoothstep01((we - 0.17) / 0.7) * smoothstep01((lGrad[i] - 0.12) / 4.9);
    const band1252Core =
      smoothstep01((L0 - profile.L12 - 0.04) / span1252) *
      (1 - smoothstep01((L0 - profile.L92) / 5.85));
    if (thinK > 0.001) {
      const thinW = catalogThinStructureWeight(lGrad[i], mGrad[i], we);
      L1 +=
        thinK *
        thinW *
        dFine *
        gateDetail *
        band1252Core *
        (0.38 + 0.62 * interiorCore) *
        structDetailMul *
        (1 +
          0.34 * drawCordZone +
          0.2 * pocketSides +
          0.42 * pocketOpenings +
          0.32 * pocketBottom +
          0.12 * hemRib +
          0.1 * sleeveCuff +
          0.12 * shoulderSeam +
          0.1 * sleeveFold);
    }
    if (hpBlend > 0.001) {
      const hpLocal =
        flatSuppress *
        (0.72 + 0.28 * Math.max(interiorCore, 0.58 * hoodStruct)) *
        (0.84 +
          0.16 * pocketStruct +
          0.15 * pocketBottom +
          0.11 * hemRib +
          0.1 * drawCordZone +
          0.08 * sleeveFold);
      L1 +=
        hpBlend *
        Math.max(-3.5, Math.min(3.5, dTex)) *
        gateDetail *
        band1252Core *
        (0.32 + 0.68 * interiorCore) *
        hpLocal *
        (1 + 0.08 * structDetailMul);
    }
    if (lapK > 0.001) {
      const lap = lLap[i];
      const lapBand =
        smoothstep01((lap - 0.048) / 1.02) *
        (1 - smoothstep01((lap - 6.4) / 4.6));
      L1 +=
        lapK *
        lapBand *
        Math.max(-3.9, Math.min(3.9, dFine)) *
        gateDetail *
        band1252Core *
        (0.36 + 0.64 * interiorCore) *
        structDetailMul *
        (1 +
          0.32 * drawCordZone +
          0.22 * pocketSides +
          0.38 * pocketOpenings +
          0.3 * pocketBottom +
          0.12 * hemRib +
          0.1 * sleeveCuff +
          0.12 * shoulderSeam +
          0.1 * sleeveFold);
    }
    const jetDetailPreset =
      preset === "very_dark_product" ||
      preset === "dark_product" ||
      profile.jetNeutral;
    const structZoneForMicro =
      jetDetailPreset
        ? Math.min(
            1,
            0.95 * hoodStruct +
              0.85 * pocketStruct +
              drawCordZone +
              pocketOpenings * 1.05 +
              pocketBottom * 0.88 +
              shoulderSeam * 0.72 +
              sleeveFold * 0.68 +
              0.55 * hemRib +
              0.52 * sleeveCuff +
              0.42 * pocketSides
          )
        : 0;
    const lowContrastRipple =
      jetDetailPreset
        ? smoothstep01((Math.abs(dFine) - 0.062) / 1.48) *
          (1 - smoothstep01(Math.abs(dLf) / 4.12)) *
          band1252Core *
          gateDetail *
          flatSuppress *
          (0.28 + 0.72 * structZoneForMicro)
        : 0;
    if (lowContrastRipple > 0.006) {
      const lcK =
        preset === "very_dark_product" || profile.jetNeutral ? 0.105 : 0.076;
      L1 +=
        lcK *
        Math.max(-2.58, Math.min(2.58, dFine)) *
        lowContrastRipple *
        haloReduce;
    }
    if (chestK > 0.001) {
      const chestW =
        smoothstep01((yNorm - 0.15) / 0.26) *
        (1 - smoothstep01((yNorm - 0.91) / 0.1));
      const sleeveW =
        0.54 + 0.46 * (1 - smoothstep01(Math.abs(xi / wm - 0.5) * 2.15));
      const midL = smoothstep01(
        (L0 - profile.L15) / Math.max(2.0, profile.L92 - profile.L15)
      );
      L1 +=
        chestK *
        chestW *
        sleeveW *
        dLm *
        gateDetail *
        midL *
        flatSuppress;
    }
    const ulBias = 0.62 * (1 - xi / wm) + 0.38 * (1 - yi / hm) - 0.5;
    const dirMask =
      smoothstep01((L0 - profile.L08) / 4.18) *
      (1 - smoothstep01((L0 - profile.L92) / 5.4));
    const hoodOpenLift =
      hoodStruct * (0.22 + 0.78 * smoothstep01((lGrad[i] - 0.32) / 2.1));
    L1 +=
      kDir *
      ulBias *
      dirMask *
      (0.28 + 0.72 * Math.min(14, Math.abs(dLm))) *
      gate *
      0.072 *
      ulBoost *
      (0.93 + 0.15 * hoodOpenLift) *
      (0.9 + 0.1 * flatSuppress);
    const claheBand =
      0.36 +
      0.64 *
        smoothstep01(
          (L0 - profile.L18 - 0.04) / Math.max(0.42, span1845)
        ) *
        (1 - smoothstep01((L0 - profile.L92) / 5.8));
    const claheGate =
      preset === "very_dark_product" ||
      preset === "dark_product" ||
      profile.jetNeutral
        ? Math.max(gate, gateDetail * 0.985)
        : gate;
    L1 +=
      claheD[i] *
      claheMix *
      claheGate *
      (0.34 + 0.46 * claheBand + 0.2 * gateDetail) *
      (0.55 + 0.45 * haloReduce) *
      (0.54 + 0.46 * flatSuppress) *
      (0.97 + 0.05 * hoodStruct + 0.04 * sleeveFold) *
      (1 - 0.24 * flatMass * lowGradPanel);
    const evenFlatK =
      preset === "very_dark_product" ||
      preset === "dark_product" ||
      profile.jetNeutral
        ? 0.084
        : 0;
    const evenFlatChest =
      flatMass *
      lowGradPanel *
      evenFlatK *
      (1 - 0.5 * smoothstep01((lGrad[i] - 0.38) / 2.05));
    L1 = L0 + (L1 - L0) * (1 - evenFlatChest);
    L1 = Math.max(0, Math.min(100, L1));
    if (preset === "very_dark_product" || profile.jetNeutral) {
      const cap = L0 < profile.L02 + 0.55 ? 1.18 : lumaCap;
      L1 = Math.min(L1, L0 + cap);
    } else if (preset === "dark_product") {
      L1 = Math.min(L1, L0 + lumaCap);
    }
    if (profile.lightGarment || L0 > profile.L95 - 6) {
      L1 = Math.min(L1, hiCap);
    }
    const gBoost = 1 + 0.48 * smoothstep01((lGrad[i] - 0.32) / gRef);
    const interiorWe = smoothstep01((we - 0.16) / 0.74);
    const interiorGrad = smoothstep01((lGrad[i] - 0.16) / (gRef * 1.12));
    const interiorDetail = interiorWe * (0.52 + 0.48 * interiorGrad);
    const selectiveUsm =
      0.19 * pocketOpenings +
      0.15 * pocketBottom +
      0.2 * drawCordZone +
      0.14 * hoodStruct +
      0.12 * hemRib +
      0.12 * sleeveCuff +
      0.09 * pocketStruct +
      0.1 * shoulderSeam +
      0.09 * sleeveFold;
    const usm =
      (L0 - LbW[i]) *
      usmK *
      haloReduce *
      (0.52 + 0.48 * deepGate) *
      gBoost *
      (0.88 + 0.26 * interiorDetail) *
      (1 + Math.min(0.34, selectiveUsm));
    L1 += usm;
    L1 = Math.max(0, Math.min(100, L1));
    if (preset === "very_dark_product" || profile.jetNeutral) {
      const cap2 = L0 < profile.L02 + 0.55 ? 1.18 : lumaCap;
      L1 = Math.min(L1, L0 + cap2);
    } else if (preset === "dark_product") {
      L1 = Math.min(L1, L0 + lumaCap);
    }
    if (profile.lightGarment || L0 > profile.L95 - 6) {
      L1 = Math.min(L1, hiCap);
    }
    if (L0 <= profile.L02 + 0.22) {
      L1 = Math.min(L1, L0 + 0.92);
    } else if (L0 <= profile.L05 + 0.35 && (preset === "very_dark_product" || profile.jetNeutral)) {
      L1 = Math.min(L1, L0 + 1.72);
    }
    const flatBleach = flatMass * lowGradPanel;
    const structForRetain = Math.min(
      1,
      0.2 * smoothstep01(lGrad[i] / 3.85) +
        0.58 * pocketOpenings +
        0.48 * pocketBottom +
        0.52 * drawCordZone +
        0.34 * hoodStruct +
        0.24 * hemRib +
        0.22 * sleeveCuff +
        0.2 * pocketSides +
        0.14 * pocketStruct +
        0.16 * shoulderSeam +
        0.14 * sleeveFold
    );
    const flatBleachRel = flatBleach * (1 - 0.74 * structForRetain);
    const jetBlackRetain =
      preset === "very_dark_product" ||
      preset === "dark_product" ||
      profile.jetNeutral;
    const detailRetain = jetBlackRetain
      ? edgeW *
        edgeMix *
        (0.075 + 0.925 * structForRetain * (1 - 0.84 * flatBleachRel))
      : edgeW * edgeMix;
    const detailPrior = Math.min(
      1,
      0.62 * pocketOpenings +
        0.55 * pocketBottom +
        0.72 * drawCordZone +
        0.44 * hoodStruct +
        0.32 * hemRib +
        0.32 * sleeveCuff +
        0.26 * pocketSides +
        0.18 * pocketStruct +
        0.2 * shoulderSeam +
        0.18 * sleeveFold +
        0.14 * smoothstep01(lGrad[i] / 3.6)
    );
    const spanMidJet = Math.max(
      0.38,
      (profile.L22 + profile.L35) * 0.5 - profile.L10
    );
    const bandMidLJet =
      smoothstep01((L0 - profile.L10) / spanMidJet) *
      (1 - smoothstep01((L0 - profile.L92) / 5.85));
    const overlayStructGate =
      0.5 +
      0.5 *
        Math.max(detailPrior, smoothstep01(lGrad[i] / 1.18));
    const overlayBase =
      preset === "very_dark_product" || profile.jetNeutral
        ? 0.052 + 0.128 * detailPrior
        : 0.046 + 0.115 * detailPrior;
    const overlayDelta =
      jetBlackRetain
        ? edgeW *
          gateDetail *
          Math.max(-2.75, Math.min(2.75, dFine)) *
          bandMidLJet *
          overlayBase *
          (1 - 0.76 * flatBleach) *
          overlayStructGate
        : 0;
    let Lmix = L0 + detailRetain * (L1 - L0) + overlayDelta;
    if (preset === "very_dark_product" || profile.jetNeutral) {
      let maxLift = L0 < profile.L08 ? 2.38 : L0 < profile.L18 ? 3.45 : 4.55;
      if (L0 > profile.L52) maxLift = Math.min(maxLift, 3.95);
      Lmix = Math.min(Lmix, L0 + maxLift);
      if (L0 <= profile.L10 + 0.12) {
        const capDeep = structForRetain > 0.34 ? 1.2 : 1.02;
        Lmix = Math.min(Lmix, L0 + capDeep);
      } else if (L0 < profile.L35) {
        const spanTJ = Math.max(0.48, profile.L35 - profile.L10);
        const capTJ = 1.08 + ((L0 - profile.L10) / spanTJ) * 2.05;
        Lmix = Math.min(Lmix, L0 + Math.min(maxLift * 0.78, capTJ));
      }
      if (flatBleach > 0.42) {
        const pull0 =
          0.58 + 0.42 * (1 - smoothstep01((flatBleach - 0.42) / 0.38));
        const pullEased = Math.min(1, pull0 + (1 - pull0) * 0.52 * structForRetain);
        Lmix = L0 + (Lmix - L0) * pullEased;
      }
    } else if (preset === "dark_product") {
      let maxLiftD = L0 < profile.L10 ? 2.65 : L0 < profile.L22 ? 3.9 : 5.05;
      Lmix = Math.min(Lmix, L0 + maxLiftD);
      if (flatBleach > 0.48) {
        const pullD =
          0.64 + 0.36 * (1 - smoothstep01((flatBleach - 0.48) / 0.35));
        const pullDE = Math.min(1, pullD + (1 - pullD) * 0.45 * structForRetain);
        Lmix = L0 + (Lmix - L0) * pullDE;
      }
    }
    Lmix = Math.max(0, Math.min(100, Lmix));
    const out = labToSrgb8(Lmix, lab0.a, lab0.b);
    d[o] = out.r;
    d[o + 1] = out.g;
    d[o + 2] = out.b;
    d[o + 3] = 255;
  }

  for (let i = 0; i < n; i++) {
    if (wEnh[i] < 0.038) {
      const o = i * 4;
      d[o] = orig[o];
      d[o + 1] = orig[o + 1];
      d[o + 2] = orig[o + 2];
    }
  }

  applyCatalogEnhanceSafetyPass(
    d,
    orig,
    wEnh,
    w,
    h,
    profile,
    preset,
    br,
    bg,
    bb
  );

  catalogRestorePureWhiteBackdrop(d, wEnh, w, h, br, bg, bb);

  ctx.putImageData(img, 0, 0);
}

/**
 * Max |Δα| in a (2r+1)×(2r+1) window (silhouette / stair-step cue). r=1 → 3×3; r=2 → 5×5 for cutouts.
 * Cached for LAB recolor: high-α fringe pixels need extra decontam vs backdrop.
 */
function computeMaskAlphaGradientMax(alphaRaw, w, h, neighborRadius = 1) {
  const n = w * h;
  const r = Math.max(1, Math.min(3, neighborRadius | 0));
  const gmax = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a0 = alphaRaw[i];
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!dx && !dy) continue;
          const yy = y + dy;
          const xx = x + dx;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const da = Math.abs(a0 - alphaRaw[yy * w + xx]);
          if (da > m) m = da;
        }
      }
      gmax[i] = m;
    }
  }
  return gmax;
}

function computeMaskAlphaGradientMax3x3(alphaRaw, w, h) {
  return computeMaskAlphaGradientMax(alphaRaw, w, h, 1);
}

/** Max neutral luminance in 3×3 — “bright neighbor” flags contact shadow / backdrop-adjacent gray. */
function computeNeutralNeighborMaxLuma3x3(neutralRgba, w, h) {
  const n = w * h;
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = -1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const ni = yy * w + xx;
          const o = ni * 4;
          const L = luminanceRgb(
            neutralRgba[o],
            neutralRgba[o + 1],
            neutralRgba[o + 2]
          );
          if (L > mx) mx = L;
        }
      }
      out[y * w + x] = mx;
    }
  }
  return out;
}

function erodeMaskAlphaPlane(alphaIn, w, h, passes) {
  const n = w * h;
  let a = new Uint8Array(alphaIn);
  let b = new Uint8Array(n);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 255;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) {
              m = 0;
            } else {
              m = Math.min(m, a[ny * w + nx]);
            }
          }
        }
        b[y * w + x] = m;
      }
    }
    const t = a;
    a = b;
    b = t;
  }
  return a;
}

/** 3×3 median on α — kills specks / 1px spurs from segmenters before gentle blur (cutout prep only). */
function medianFilterAlphaPlane3x3(alphaIn, w, h) {
  const out = new Uint8Array(w * h);
  const buf = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          buf[k++] = alphaIn[yy * w + xx];
        }
      }
      for (let i = 1; i < 9; i++) {
        const t = buf[i];
        let j = i;
        while (j > 0 && buf[j - 1] > t) {
          buf[j] = buf[j - 1];
          j--;
        }
        buf[j] = t;
      }
      out[y * w + x] = buf[4];
    }
  }
  return out;
}

function blurAlphaPlaneGaussian3(alphaIn, w, h, passes = 1) {
  let a = new Float32Array(alphaIn.length);
  for (let i = 0; i < alphaIn.length; i++) a[i] = alphaIn[i];
  let b = new Float32Array(alphaIn.length);
  const k = [0.27901, 0.44198, 0.27901];
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          s += a[row + nx] * k[dx + 1];
        }
        b[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          s += b[ny * w + x] * k[dy + 1];
        }
        a[y * w + x] = s;
      }
    }
  }
  const out = new Uint8Array(alphaIn.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.max(0, Math.min(255, a[i])));
  }
  return out;
}

function supersampleMaskAlphaAA(canvas, factor = 2) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 2 || h < 2 || factor < 2) return;
  const ctx = canvas.getContext("2d");
  const src = ctx.getImageData(0, 0, w, h);
  const sd = src.data;
  const aSmall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) aSmall[i] = sd[i * 4 + 3];

  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d");
  const sImg = sctx.createImageData(w, h);
  const sdd = sImg.data;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    sdd[o] = 255;
    sdd[o + 1] = 255;
    sdd[o + 2] = 255;
    sdd[o + 3] = aSmall[i];
  }
  sctx.putImageData(sImg, 0, 0);

  const hw = w * factor;
  const hh = h * factor;
  const hi = document.createElement("canvas");
  hi.width = hw;
  hi.height = hh;
  const hctx = hi.getContext("2d", { willReadFrequently: true });
  hctx.imageSmoothingEnabled = true;
  hctx.imageSmoothingQuality = "high";
  hctx.drawImage(small, 0, 0, w, h, 0, 0, hw, hh);
  const hImg = hctx.getImageData(0, 0, hw, hh);
  const hd = hImg.data;
  const aHi = new Uint8Array(hw * hh);
  for (let i = 0; i < hw * hh; i++) aHi[i] = hd[i * 4 + 3];
  const aHiSm = blurAlphaPlaneGaussian3(
    aHi,
    hw,
    hh,
    factor >= 3 ? 2 : 1
  );
  for (let i = 0; i < hw * hh; i++) hd[i * 4 + 3] = aHiSm[i];
  hctx.putImageData(hImg, 0, 0);

  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(hi, 0, 0, hw, hh, 0, 0, w, h);
}

/**
 * Before luminance tint: reduce JPEG / matting red–green fringe and chroma spikes vs local 3×3 mean.
 * Skips deep shadows unless saturation is extreme (hood/armpit color bleed, not real shade).
 */
function neutralizeJpegChromaFringeInPlace(d, alphaRaw, alphaE, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const raw = alphaRaw[i];
      const er = alphaE[i];
      const edgeStr = (255 - Math.min(raw, er)) / 255;
      const inSoftMask = raw > 0 && raw < 254;
      if (er < 6 && !inSoftMask) continue;

      const o = i * 4;
      let sr = d[o];
      let sg = d[o + 1];
      let sb = d[o + 2];
      const lumS = luminanceRgb(sr, sg, sb);
      const chroma = Math.max(sr, sg, sb) - Math.min(sr, sg, sb);
      const extremeChroma = chroma > 52;
      const maxGB = Math.max(sg, sb);
      /** Hood / pocket shadows still carry capture hue; don’t skip fringe pull there. */
      /** Hood / interior often ~lum 90–150 with leftover capture red from JPEG or prior mockup. */
      const redSpill =
        raw > 8 && sr > maxGB + 14 && lumS < 172;
      if (lumS < 94 && !extremeChroma && !redSpill) continue;
      if (lumS < 68 && !redSpill && !extremeChroma) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (alphaE[ni] < 6 && !(alphaRaw[ni] > 0 && alphaRaw[ni] < 254)) continue;
          const p = ni * 4;
          sumR += d[p];
          sumG += d[p + 1];
          sumB += d[p + 2];
          c++;
        }
      }
      if (c < 3) continue;
      const ar = sumR / c;
      const ag = sumG / c;
      const ab = sumB / c;
      const outlierR = sr - ar;
      const outlierG = sg - ag;

      if (sr > 72 && sr > maxGB + 12) {
        const pull = Math.min(
          0.94,
          (0.38 + 0.56 * edgeStr) * Math.min(1, (sr - maxGB - 12) / 58)
        );
        if (outlierR > 18) {
          const amp = Math.min(0.95, pull * (0.55 + 0.45 * Math.min(1, outlierR / 48)));
          sr = sr * (1 - amp) + ar * amp;
          sg = sg * (1 - amp * 0.38) + ag * (amp * 0.38);
          sb = sb * (1 - amp * 0.38) + ab * (amp * 0.38);
        } else if (edgeStr > 0.12 && sr > maxGB + 18) {
          const amp = pull * 0.72;
          sr = sr * (1 - amp) + ar * amp;
          sg = sg * (1 - amp * 0.32) + ag * (amp * 0.32);
          sb = sb * (1 - amp * 0.32) + ab * (amp * 0.32);
        }
      }

      const maxRB = Math.max(sr, sb);
      if (sg > 72 && sg > maxRB + 12) {
        const pullG = Math.min(
          0.94,
          (0.38 + 0.56 * edgeStr) * Math.min(1, (sg - maxRB - 12) / 58)
        );
        if (outlierG > 18) {
          const ampG = Math.min(
            0.95,
            pullG * (0.55 + 0.45 * Math.min(1, outlierG / 48))
          );
          sr = sr * (1 - ampG * 0.38) + ar * (ampG * 0.38);
          sg = sg * (1 - ampG) + ag * ampG;
          sb = sb * (1 - ampG * 0.38) + ab * (ampG * 0.38);
        } else if (edgeStr > 0.12 && sg > maxRB + 18) {
          const ampG = pullG * 0.72;
          sr = sr * (1 - ampG * 0.32) + ar * (ampG * 0.32);
          sg = sg * (1 - ampG) + ag * ampG;
          sb = sb * (1 - ampG * 0.32) + ab * (ampG * 0.32);
        }
      }

      const chroma2 =
        Math.max(sr, sg, sb) - Math.min(sr, sg, sb);
      if (chroma2 > 36 && (edgeStr > 0.06 || extremeChroma)) {
        const satPull =
          (0.22 + 0.5 * edgeStr + (extremeChroma ? 0.2 : 0)) *
          Math.min(1, (chroma2 - 36) / 70);
        sr = sr * (1 - satPull) + ar * satPull;
        sg = sg * (1 - satPull) + ag * satPull;
        sb = sb * (1 - satPull) + ab * satPull;
      }

      /** Tan / yellow JPEG fringe (high R+G, low B) reads as gold halos after dark recolor. */
      const minRG = Math.min(sr, sg);
      const warmCast =
        lumS > 58 &&
        minRG > sb + 14 &&
        sr > 55 &&
        sg > 50 &&
        (edgeStr > 0.045 || raw < 150);
      if (warmCast) {
        const warmth = Math.min(1, (minRG - sb) / 72);
        /** Dark brown fabric + tan matting: slightly stronger pull than mid-tones. */
        const edgeBoost =
          lumS < 92 ? Math.min(1.12, 1 + (92 - lumS) / 220) : 1;
        const pullW =
          Math.min(0.94, (0.3 + 0.55 * edgeStr) * warmth * edgeBoost);
        const Ln = luminanceRgb(ar, ag, ab);
        const Lt = Math.round(Math.min(255, Math.max(0, Ln)));
        sr = sr * (1 - pullW) + Lt * pullW;
        sg = sg * (1 - pullW) + Lt * pullW;
        sb = sb * (1 - pullW) + Lt * pullW;
      }

      /** Cyan / blue matting fringe on black & navy (reads as gray–blue halo after recolor). */
      const maxRG2 = Math.max(sr, sg);
      const coolSpill =
        raw > 5 &&
        sb > maxRG2 + 10 &&
        lumS < 168 &&
        (edgeStr > 0.035 || inSoftMask);
      if (coolSpill) {
        const cbPull = Math.min(
          0.9,
          (0.34 + 0.52 * edgeStr) *
            Math.min(1, (sb - maxRG2 - 10) / 52)
        );
        sb = sb * (1 - cbPull) + ab * cbPull;
        sr = sr * (1 - cbPull * 0.42) + ar * (cbPull * 0.42);
        sg = sg * (1 - cbPull * 0.42) + ag * (cbPull * 0.42);
      }
      /**
       * Deep shadow cyan cleanup (important for orange/amber recolors): blue spill in folds becomes muddy.
       */
      const deepCyanShadow =
        raw > 4 &&
        lumS < 96 &&
        sb > sr + 9 &&
        sb > sg + 6 &&
        (edgeStr > 0.03 || inSoftMask);
      if (deepCyanShadow) {
        const tC =
          Math.min(0.95, 0.42 + 0.48 * edgeStr + 0.22 * (1 - lumS / 96));
        const capB = Math.max(sr, sg) + 4;
        sb = sb * (1 - tC) + Math.min(sb, capB) * tC;
        sr = sr * (1 - tC * 0.44) + ar * (tC * 0.44);
        sg = sg * (1 - tC * 0.44) + ag * (tC * 0.44);
      }

      /** Mint / aqua fringe (G+B high vs R) on green garments vs white — common JPEG + matting artifact. */
      const minGB = Math.min(sg, sb);
      const mintFringe =
        raw > 5 &&
        minGB > sr + 11 &&
        lumS > 82 &&
        lumS < 232 &&
        (edgeStr > 0.032 || inSoftMask);
      if (mintFringe) {
        const mPull = Math.min(
          0.86,
          (0.26 + 0.5 * edgeStr) *
            Math.min(1, (minGB - sr - 11) / 58)
        );
        sr = sr * (1 - mPull * 0.35) + ar * (mPull * 0.35);
        sg = sg * (1 - mPull * 0.42) + ag * (mPull * 0.42);
        sb = sb * (1 - mPull * 0.48) + ab * (mPull * 0.48);
      }

      d[o] = Math.round(Math.min(255, Math.max(0, sr)));
      d[o + 1] = Math.round(Math.min(255, Math.max(0, sg)));
      d[o + 2] = Math.round(Math.min(255, Math.max(0, sb)));
    }
  }
}

/**
 * AI/rembg on red cycloramas: semi-transparent edge pixels stay scarlet vs maroon body — pull toward
 * local mean so tint + defringe see neutralized luma/chroma.
 */
function neutralizeRedKeyMattingSpillInPlace(d, alphaRaw, alphaE, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const raw = alphaRaw[i];
      const er = alphaE[i];
      if (raw < 3 || raw > 236) continue;
      const edgeStr = (255 - Math.min(raw, er)) / 255;
      if (edgeStr < 0.028 && raw > 110) continue;
      const o = i * 4;
      let sr = d[o];
      let sg = d[o + 1];
      let sb = d[o + 2];
      if (baseRgbLooksLikeRedChromaKey(sr, sg, sb) && raw < 200) {
        const L = Math.round(
          Math.min(255, Math.max(0, luminanceRgb(sr, sg, sb)))
        );
        const t = 0.55 + 0.35 * edgeStr + 0.2 * (1 - raw / 200);
        const u = Math.min(1, t);
        sr = Math.round(sr * (1 - u) + L * u);
        sg = Math.round(sg * (1 - u) + L * u);
        sb = Math.round(sb * (1 - u) + L * u);
        d[o] = sr;
        d[o + 1] = sg;
        d[o + 2] = sb;
        continue;
      }
      if (!state.externalMaskActive) continue;
      const maxGB = Math.max(sg, sb);
      if (sr < 112 || sr < maxGB + 20) continue;
      const lumS = luminanceRgb(sr, sg, sb);
      if (lumS > 218) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (alphaRaw[ni] < 4) continue;
          const p = ni * 4;
          sumR += d[p];
          sumG += d[p + 1];
          sumB += d[p + 2];
          c++;
        }
      }
      if (c < 3) continue;
      const ar = sumR / c;
      const ag = sumG / c;
      const ab = sumB / c;
      const pull = Math.min(
        0.96,
        (0.48 + 0.52 * edgeStr) *
          Math.min(1, (sr - maxGB - 18) / 44) *
          (raw < 140 ? 1.12 : 1)
      );
      sr = sr * (1 - pull) + ar * pull;
      sg = sg * (1 - pull * 0.45) + ag * (pull * 0.45);
      sb = sb * (1 - pull * 0.45) + ab * (pull * 0.45);
      d[o] = Math.round(Math.min(255, Math.max(0, sr)));
      d[o + 1] = Math.round(Math.min(255, Math.max(0, sg)));
      d[o + 2] = Math.round(Math.min(255, Math.max(0, sb)));
    }
  }
}

/**
 * AI/rembg on green screens: semi-transparent edges stay lime vs forest body — pull toward local mean.
 */
function neutralizeGreenKeyMattingSpillInPlace(d, alphaRaw, alphaE, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const raw = alphaRaw[i];
      const er = alphaE[i];
      if (raw < 3 || raw > 236) continue;
      const edgeStr = (255 - Math.min(raw, er)) / 255;
      if (edgeStr < 0.028 && raw > 110) continue;
      const o = i * 4;
      let sr = d[o];
      let sg = d[o + 1];
      let sb = d[o + 2];
      if (baseRgbLooksLikeGreenChromaKey(sr, sg, sb) && raw < 200) {
        const L = Math.round(
          Math.min(255, Math.max(0, luminanceRgb(sr, sg, sb)))
        );
        const t = 0.55 + 0.35 * edgeStr + 0.2 * (1 - raw / 200);
        const u = Math.min(1, t);
        sr = Math.round(sr * (1 - u) + L * u);
        sg = Math.round(sg * (1 - u) + L * u);
        sb = Math.round(sb * (1 - u) + L * u);
        d[o] = sr;
        d[o + 1] = sg;
        d[o + 2] = sb;
        continue;
      }
      const maxRB = Math.max(sr, sb);
      if (sg < 98 || sg < maxRB + 16) continue;
      const lumS = luminanceRgb(sr, sg, sb);
      if (lumS > 228) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (alphaRaw[ni] < 4) continue;
          const p = ni * 4;
          sumR += d[p];
          sumG += d[p + 1];
          sumB += d[p + 2];
          c++;
        }
      }
      if (c < 3) continue;
      const ar = sumR / c;
      const ag = sumG / c;
      const ab = sumB / c;
      const pull = Math.min(
        0.96,
        (0.48 + 0.52 * edgeStr) *
          Math.min(1, (sg - maxRB - 18) / 44) *
          (raw < 140 ? 1.12 : 1)
      );
      sr = sr * (1 - pull * 0.45) + ar * (pull * 0.45);
      sg = sg * (1 - pull) + ag * pull;
      sb = sb * (1 - pull * 0.45) + ab * (pull * 0.45);
      d[o] = Math.round(Math.min(255, Math.max(0, sr)));
      d[o + 1] = Math.round(Math.min(255, Math.max(0, sg)));
      d[o + 2] = Math.round(Math.min(255, Math.max(0, sb)));
    }
  }
}

/**
 * Strip capture color (chroma) under the garment mask before swatch tint. Source hue was leaking
 * through texturePreserve and through pixels skipped by eroded-only masking (red halos on recolor).
 * Luminance is kept; fringe uses a short alpha ramp, core is fully luma so recolor matches neutral base.
 */
function desaturateGarmentUnderMaskInPlace(d, alphaRaw, w, h, chromaKeyHint) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 2) continue;
    const o = i * 4;
    const sr = d[o];
    const sg = d[o + 1];
    const sb = d[o + 2];
    const L = luminanceRgb(sr, sg, sb);
    const Lr = Math.round(Math.min(255, Math.max(0, L)));
    let wmix =
      chromaKeyHint && chromaKeyHint[i]
        ? 1
        : a >= 22
          ? 1
          : smoothstep01((a - 2) / 22);
    const chroma = Math.max(sr, sg, sb) - Math.min(sr, sg, sb);
    if (chroma > 38 && sr > Math.max(sg, sb) + 10) {
      wmix = Math.min(1, wmix + 0.4);
    }
    if (sr > Math.max(sg, sb) + 18 && chroma > 28) {
      wmix = Math.min(1, wmix + 0.28);
    }
    if (chroma > 38 && sg > Math.max(sr, sb) + 10) {
      wmix = Math.min(1, wmix + 0.4);
    }
    if (sg > Math.max(sr, sb) + 18 && chroma > 28) {
      wmix = Math.min(1, wmix + 0.28);
    }
    const inv = 1 - wmix;
    d[o] = Math.round(sr * inv + Lr * wmix);
    d[o + 1] = Math.round(sg * inv + Lr * wmix);
    d[o + 2] = Math.round(sb * inv + Lr * wmix);
  }
}

/**
 * PNG / rembg matting: dark RGB on partial garment alpha is not deep fabric. Nudge toward neighbor body luma so
 * forest / bottle swatches avoid a black “stroke” on white (softCeil was keyed off dark edge luma).
 */
function liftDarkMattingRgbAlongSoftMask(d, alphaRaw, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 18 || a > 238) continue;
    const o = i * 4;
    const L = luminanceRgb(d[o], d[o + 1], d[o + 2]);
    if (L > 102) continue;
    let sumL = 0;
    let cnt = 0;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -2; dx <= 2; dx++) {
        if (dy === 0 && dx === 0) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const ni = yy * w + xx;
        if (alphaRaw[ni] < 72) continue;
        const p = ni * 4;
        sumL += luminanceRgb(d[p], d[p + 1], d[p + 2]);
        cnt++;
      }
    }
    if (cnt < 4) continue;
    const meanL = sumL / cnt;
    if (meanL < 118) continue;
    let u =
      (1 - a / 255) *
      0.58 *
      smoothstep01((100 - L) / 92) *
      smoothstep01((meanL - 108) / 95);
    if (a > 198) {
      u *= 0.38 + 0.62 * (1 - smoothstep01((a - 198) / 48));
    }
    if (u < 0.018) continue;
    const Lr = Math.round(meanL);
    d[o] = Math.round(d[o] * (1 - u) + Lr * u);
    d[o + 1] = Math.round(d[o + 1] * (1 - u) + Lr * u);
    d[o + 2] = Math.round(d[o + 2] * (1 - u) + Lr * u);
  }
}

/**
 * Cutout PNGs on bright backdrops: semi-opaque edge pixels keep green/cyan from matting — blend toward scene
 * (color decontamination) so recolor doesn’t leave a greenish halo vs #fff.
 */
function decontaminateGreenishFringeTowardScene(
  d,
  alphaRaw,
  w,
  h,
  bgR,
  bgG,
  bgB,
  strengthMult = 1
) {
  if (luminanceRgb(bgR, bgG, bgB) < 235) return;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 5) continue;
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = luminanceRgb(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    /** Semi-transparent edge (PNG matting + soft mask). */
    const softFringe = a <= 138;
    /**
     * Dark green/black ring often has surprisingly high mask alpha — previous cap at a≤128 missed it.
     */
    const darkMatteRim =
      a >= 48 &&
      a < 252 &&
      L < 100 &&
      chroma >= 12 &&
      g + 3 >= Math.max(r, b);
    if (!softFringe && !darkMatteRim) continue;
    if (!darkMatteRim && g < Math.max(r, b) + 5) continue;
    if (darkMatteRim && g < Math.max(r, b) + 2) continue;
    if (chroma < (darkMatteRim ? 7 : 10)) continue;
    let outer;
    if (darkMatteRim) {
      outer =
        (1 - smoothstep01((L - 22) / 78)) *
        (1 - smoothstep01((a - 48) / 200));
    } else {
      outer = 1 - smoothstep01(a / 132);
    }
    const base = darkMatteRim ? 0.34 + 0.44 * outer : 0.26 + 0.38 * outer;
    let t =
      Math.min(darkMatteRim ? 0.78 : 0.62, base) *
      Math.min(1, chroma / 50) *
      strengthMult;
    if (t < 0.035) continue;
    d[o] = Math.round(r * (1 - t) + bgR * t);
    d[o + 1] = Math.round(g * (1 - t) + bgG * t);
    d[o + 2] = Math.round(b * (1 - t) + bgB * t);
  }
}

/**
 * Dark “stroke” on JPEG flat-lays: RGB is often neutral or muddy, not green‑dominant, but the pixel still sits on a
 * **steep garment-mask ramp** (true outer silhouette). Blend those low-luma rim pixels toward the backdrop.
 */
function decontaminateMaskGradientRimTowardScene(
  d,
  alphaRaw,
  w,
  h,
  bgR,
  bgG,
  bgB,
  strengthMult = 1
) {
  if (luminanceRgb(bgR, bgG, bgB) < 235) return;
  const n = w * h;
  const gmax = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a0 = alphaRaw[i];
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const da = Math.abs(a0 - alphaRaw[yy * w + xx]);
          if (da > m) m = da;
        }
      }
      gmax[i] = m;
    }
  }
  for (let i = 0; i < n; i++) {
    if (gmax[i] < 17) continue;
    const a = alphaRaw[i];
    /**
     * White background + border alpha band: decontaminate all 0.1..0.8 alpha pixels toward scene
     * to prevent tint leakage/smudge on the silhouette.
     */
    if (a >= 22 && a <= 228) {
      const o = i * 4;
      d[o] = bgR;
      d[o + 1] = bgG;
      d[o + 2] = bgB;
      continue;
    }
    if (a < 62 || a > 252) continue;
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = luminanceRgb(r, g, b);
    if (L > 142) continue;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > 52 && L > 102) continue;
    const edgeStr = Math.min(1, (gmax[i] - 16) / 102);
    const darkStr = 1 - smoothstep01((L - 28) / 102);
    let t = 0.36 * edgeStr * darkStr * strengthMult;
    if (a > 190) {
      let hiAtten =
        0.48 + 0.52 * (1 - smoothstep01((a - 190) / 65));
      /**
       * Default **hiAtten** targets bright hair-style fringe. **Dark high-α** matting (α≈1 on a 1px “cord”) was
       * incorrectly weakened — leave a stuck halo vs #fff.
       */
      if (L < 118) {
        hiAtten = Math.max(
          hiAtten,
          0.8 + 0.2 * (1 - smoothstep01((a - 198) / 54))
        );
      }
      t *= hiAtten;
    }
    if (L < 124 && a > 178) {
      t = Math.min(
        0.9,
        t * (1.1 + 0.48 * (1 - smoothstep01((L - 48) / 76)))
      );
    }
    if (t < 0.028) continue;
    d[o] = Math.round(r * (1 - t) + bgR * t);
    d[o + 1] = Math.round(g * (1 - t) + bgG * t);
    d[o + 2] = Math.round(b * (1 - t) + bgB * t);
  }
}

/**
 * **Residual matting / contact shadow:** the mask often stays **high-alpha** on a 1–2 px dark gray ring (not
 * chroma-key green). `liftDarkMattingRgbAlongSoftMask` skips `a > 218`, so that ring still picks up swatch chroma.
 * (1) **Interior dip:** darker than nearby α≥168 “body” fabric on a steep α ramp.
 * (2) **Silhouette rim:** touches low-α / backdrop in 3×3 but is still mid-α — no bright in-mask neighbor, so (1)
 *     often misses the outermost fringe; blend using openness toward transparency instead of `gap`.
 */
function decontaminateContactShadowMattingTowardScene(
  d,
  alphaRaw,
  w,
  h,
  bgR,
  bgG,
  bgB,
  strengthMult = 1
) {
  if (luminanceRgb(bgR, bgG, bgB) < 235) return;
  const n = w * h;
  const rad = 3;
  const aFloor = 168;
  const maxInteriorL = new Float32Array(n);
  const gmax = new Uint8Array(n);
  const alphaMin3 = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let mxL = -1;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const ni = yy * w + xx;
          if (alphaRaw[ni] < aFloor) continue;
          const o = ni * 4;
          const Ln = luminanceRgb(d[o], d[o + 1], d[o + 2]);
          if (Ln > mxL) mxL = Ln;
        }
      }
      maxInteriorL[i] = mxL;
      const a0 = alphaRaw[i];
      let m = 0;
      let mnA = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const ni = yy * w + xx;
          const an = alphaRaw[ni];
          const da = Math.abs(a0 - an);
          if (da > m) m = da;
          if (an < mnA) mnA = an;
        }
      }
      gmax[i] = m;
      alphaMin3[i] = mnA;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 24 || a > 252) continue;
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = luminanceRgb(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const grad = gmax[i];
    const amin = alphaMin3[i];

    let t = 0;

    const refL = maxInteriorL[i];
    if (refL >= 104) {
      const gap = refL - L;
      if (
        gap >= 24 &&
        L <= 152 &&
        !(chroma > 48 && L > 68) &&
        ((a >= 205 && grad >= 28) || (a < 205 && grad >= 14))
      ) {
        const highAlphaRim = a >= 205;
        const edgeStr = Math.min(
          1,
          (grad - (highAlphaRim ? 26 : 12)) / 90
        );
        const gapStr = smoothstep01((gap - 24) / 80);
        const darkStr = 1 - smoothstep01((L - 32) / 106);
        t = Math.max(
          t,
          (highAlphaRim ? 0.45 : 0.34) *
            edgeStr *
            gapStr *
            darkStr *
            strengthMult
        );
      }
    }

    if (amin < 118 && a <= 246 && L < 148 && chroma < 60 && grad >= 10) {
      const open = 1 - smoothstep01(amin / 118);
      const edgeStr = Math.min(1, (grad - 8) / 86);
      const darkStr = 1 - smoothstep01((L - 38) / 104);
      const satAtten = 1 - 0.42 * smoothstep01((chroma - 22) / 42);
      t = Math.max(
        t,
        (0.24 + 0.46 * open) *
          edgeStr *
          darkStr *
          satAtten *
          strengthMult
      );
    }

    /**
     * Uniform dark **high-α** column along the silhouette: every in-mask neighbor is similarly dark, so `gap≈0`,
     * but α still ramps vs backdrop a few px away — kill the “cord” on long limbs.
     */
    if (
      grad >= 34 &&
      L < 124 &&
      a >= 158 &&
      a <= 250 &&
      chroma < 56
    ) {
      const edgeStr = smoothstep01((grad - 34) / 76);
      const darkStr = 1 - smoothstep01((L - 36) / 86);
      t = Math.max(
        t,
        0.48 * edgeStr * darkStr * strengthMult
      );
    }

    t = Math.min(0.97, t);
    if (t < 0.028) continue;
    d[o] = Math.round(r * (1 - t) + bgR * t);
    d[o + 1] = Math.round(g * (1 - t) + bgG * t);
    d[o + 2] = Math.round(b * (1 - t) + bgB * t);
  }
}

/**
 * **Semi-opaque matting + contact-shadow mix (studio white):** assume straight-alpha composite
 * `C ≈ F·α + Bg·(1−α)` on a near-white backdrop. Mixed pixels read **too dark**; solving for `F` lifts RGB toward
 * the true (less contaminated) foreground so recolor is not “tint × muddy edge”. Silhouette-gated so interior
 * fabric is untouched. Run **after** rim snap so work targets surviving **high-α** matting, not pixels already
 * replaced with `Bg`.
 */
function unmixSemiOpaqueMattingFromBackdrop(
  d,
  alphaRaw,
  w,
  h,
  bgR,
  bgG,
  bgB,
  strengthMult = 1
) {
  if (luminanceRgb(bgR, bgG, bgB) < 235) return;
  const n = w * h;
  const gmax = new Uint8Array(n);
  const amin3 = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a0 = alphaRaw[i];
      let m = 0;
      let mn = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const ni = yy * w + xx;
          const an = alphaRaw[ni];
          const da = Math.abs(a0 - an);
          if (da > m) m = da;
          if (an < mn) mn = an;
        }
      }
      gmax[i] = m;
      amin3[i] = mn;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 14 || a > 252) continue;
    const af = Math.max(0.055, a / 255);
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = luminanceRgb(r, g, b);
    if (L > 158) continue;

    const grad = gmax[i];
    const amin = amin3[i];
    if (grad < 12 && amin > 200) continue;

    const fr = (r - bgR * (1 - af)) / af;
    const fg = (g - bgG * (1 - af)) / af;
    const fb = (b - bgB * (1 - af)) / af;
    const fR = Math.min(255, Math.max(0, fr));
    const fG = Math.min(255, Math.max(0, fg));
    const fB = Math.min(255, Math.max(0, fb));
    const Lf = luminanceRgb(fR, fG, fB);
    if (Lf <= L + 3) continue;

    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const semi = smoothstep01((a - 20) / 218);
    const silhouette = Math.max(
      smoothstep01((grad - 10) / 82),
      1 - smoothstep01(amin / 122)
    );
    const darkOrMuddy =
      (1 - smoothstep01((L - 40) / 112)) *
      (0.62 + 0.38 * (1 - smoothstep01((chroma - 18) / 52)));
    let wmix =
      (0.16 + 0.68 * semi * silhouette * darkOrMuddy) *
      smoothstep01((Lf - L) / 76);
    wmix *= 1 - 0.45 * smoothstep01((a - 212) / 42);
    wmix *= strengthMult;
    wmix = Math.min(0.9, wmix);
    if (wmix < 0.032) continue;

    d[o] = Math.round(r * (1 - wmix) + fR * wmix);
    d[o + 1] = Math.round(g * (1 - wmix) + fG * wmix);
    d[o + 2] = Math.round(b * (1 - wmix) + fB * wmix);
  }
}

/**
 * **Stuck dark halo:** segmenters often label shadow/matte as **α≈240–255** so unmix barely moves RGB and rim
 * soft-path attenuation used to starve cleanup. This pass targets **dark, muted** pixels that still sit on a mask
 * ramp or touch lower-α neighbors — blend hard toward the (near-white) backdrop. Skips flat interior (high amin,
 * low gmax) to avoid eating real folds.
 */
function bleachDarkHighAlphaRimOnNearWhiteBackdrop(
  d,
  alphaRaw,
  w,
  h,
  bgR,
  bgG,
  bgB,
  strengthMult = 1
) {
  if (luminanceRgb(bgR, bgG, bgB) < 235) return;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const a = alphaRaw[i];
    if (a < 192 || a > 253) continue;
    const o = i * 4;
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const L = luminanceRgb(r, g, b);
    if (L > 128) continue;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma > 64) continue;
    const x = i % w;
    const y = (i / w) | 0;
    let amin = 255;
    let gmax = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const ni = yy * w + xx;
        const an = alphaRaw[ni];
        amin = Math.min(amin, an);
        const da = Math.abs(a - an);
        if (da > gmax) gmax = da;
      }
    }
    if (amin > 198 && gmax < 13) continue;
    const open = 1 - smoothstep01(amin / 130);
    let t =
      (0.4 + 0.52 * open) *
      smoothstep01((gmax - 6) / 94) *
      (1 - smoothstep01((L - 34) / 94)) *
      strengthMult;
    t = Math.min(0.96, t);
    if (t < 0.036) continue;
    d[o] = Math.round(r * (1 - t) + bgR * t);
    d[o + 1] = Math.round(g * (1 - t) + bgG * t);
    d[o + 2] = Math.round(b * (1 - t) + bgB * t);
  }
}

/**
 * One shared prep for “Neutral base” preview and for recolor: same pixels you see in neutral, before any swatch.
 * Recolor = this ImageData + luminance-matched swatch (+ optional brightness texture / edge cleanup).
 */
function prepareMaskedNeutralBasePixels(ctx, w, h, maskNatCanvas) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const maskC = document.createElement("canvas");
  maskC.width = w;
  maskC.height = h;
  const mctx = maskC.getContext("2d");
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(maskNatCanvas, 0, 0, w, h);
  const mData = mctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const alphaRaw = new Uint8Array(n);
  const chromaKeyHint = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    alphaRaw[i] = mData[o + 3];
    if (mData[o + 3] > 3) {
      const rr = d[o];
      const gg = d[o + 1];
      const bb = d[o + 2];
      if (
        baseRgbLooksLikeGreenChromaKey(rr, gg, bb) ||
        baseRgbLooksLikeRedChromaKey(rr, gg, bb)
      ) {
        chromaKeyHint[i] = 1;
      }
    }
  }
  /**
   * Precision edge containment for recolor: shrink mask support by ~2 px, then re-feather very tightly
   * (~0.5-1 px equivalent) so edges stay crisp without color bleeding/smudge.
   */
  /**
   * **Single** α blur pass after erode. Extra passes on cutouts widened the ramp, **flattened** local `|Δα|`,
   * and left dark high-α halos barely touched by rim heuristics.
   */
  let aPre = erodeAlphaPlaneUint8(
    alphaRaw,
    w,
    h,
    state.alphaCutoutGarmentMask ? 1 : 2
  );
  if (state.alphaCutoutGarmentMask) {
    aPre = medianFilterAlphaPlane3x3(aPre, w, h);
  }
  const alphaTight = blurAlphaPlaneGaussian3(aPre, w, h, 1);
  for (let i = 0; i < n; i++) alphaRaw[i] = alphaTight[i];
  if (state.alphaCutoutGarmentMask) {
    liftDarkMattingRgbAlongSoftMask(d, alphaRaw, w, h);
  }
  const { r: sbr, g: sbg, b: sbb } = parseHexRgb(getEffectiveBackgroundHex());
  const brightStudioBg = luminanceRgb(sbr, sbg, sbb) > 235;
  if (brightStudioBg) {
    decontaminateGreenishFringeTowardScene(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 1.28 : 0.8
    );
    decontaminateMaskGradientRimTowardScene(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 1.08 : 0.8
    );
    unmixSemiOpaqueMattingFromBackdrop(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 1 : 0.78
    );
    decontaminateContactShadowMattingTowardScene(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 1.04 : 0.72
    );
    bleachDarkHighAlphaRimOnNearWhiteBackdrop(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 1 : 0.82
    );
  }
  /** 5×5 min; two passes on external masks ate real shadowed fabric and caused interior holes in preview. */
  const alphaE = erodeMaskAlphaPlane(alphaRaw, w, h, 1);
  const alphaNeighborMax = computeAlphaNeighborMax(alphaRaw, w, h);
  neutralizeJpegChromaFringeInPlace(d, alphaRaw, alphaE, w, h);
  neutralizeRedKeyMattingSpillInPlace(d, alphaRaw, alphaE, w, h);
  neutralizeGreenKeyMattingSpillInPlace(d, alphaRaw, alphaE, w, h);
  desaturateGarmentUnderMaskInPlace(d, alphaRaw, w, h, chromaKeyHint);
  /**
   * Last RGB touch: chroma strip + spill passes can leave a thin dark cord; bleach again on **studio white** only.
   */
  if (brightStudioBg) {
    bleachDarkHighAlphaRimOnNearWhiteBackdrop(
      d,
      alphaRaw,
      w,
      h,
      sbr,
      sbg,
      sbb,
      state.alphaCutoutGarmentMask ? 0.92 : 0.74
    );
  }
  return { imgData, d, alphaRaw, alphaE, alphaNeighborMax, n, chromaKeyHint };
}

/** Preview only: writes neutral-base pixels to ctx (no swatch). */
function applyMaskedChromaStripOnly(ctx, w, h, maskNatCanvas) {
  const { imgData } = prepareMaskedNeutralBasePixels(ctx, w, h, maskNatCanvas);
  ctx.putImageData(imgData, 0, 0);
}

/** When no garment mask: whole frame to luminance (fallback neutral preview). */
function applyFullCanvasLuminanceInPlace(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const L = Math.round(
      Math.min(255, Math.max(0, luminanceRgb(d[o], d[o + 1], d[o + 2])))
    );
    d[o] = L;
    d[o + 1] = L;
    d[o + 2] = L;
  }
  ctx.putImageData(imgData, 0, 0);
}

function renderNeutralBasePreview(target, baseImage, sceneHex, design) {
  const w = target.width;
  const h = target.height;
  const ctx = target.getContext("2d");
  const productShot = state.pureWhiteProductMode;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = sceneHex;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const mask = state.garmentMaskCanvas;
  const maskOk =
    mask &&
    mask.width > 0 &&
    mask.width === baseImage.naturalWidth &&
    mask.height === baseImage.naturalHeight;
  if (
    !productShot &&
    maskOk &&
    state.alphaCutoutGarmentMask &&
    state.contactShadowEnabled
  ) {
    drawSilhouetteContactShadowBeforeBase(ctx, w, h, mask, sceneHex);
  }
  if (maskOk && state.labRecolorPipeline) {
    const dec = ensureRecolorDecomposition(w, h, baseImage, mask);
    const img = ctx.getImageData(0, 0, w, h);
    const dd = img.data;
    const sceneRgb = parseHexRgb(sceneHex);
    const br = productShot ? 255 : sceneRgb.r;
    const bg = productShot ? 255 : sceneRgb.g;
    const bb = productShot ? 255 : sceneRgb.b;
    for (let i = 0; i < dec.n; i++) {
      const a = dec.alphaRaw[i];
      if (a < 2) continue;
      if (productShot && a < 6) continue;
      const o = i * 4;
      const L = dec.Lstar[i];
      const g8 = Math.round(Math.min(255, Math.max(0, (L / 100) * 255)));
      const eb = productShot
        ? 1 - smoothstep01((a - 30) / 2.8)
        : 1 - smoothstep01((a - 3) / 52);
      dd[o] = Math.round(g8 * (1 - eb) + br * eb);
      dd[o + 1] = Math.round(g8 * (1 - eb) + bg * eb);
      dd[o + 2] = Math.round(g8 * (1 - eb) + bb * eb);
      dd[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  } else {
    ctx.drawImage(baseImage, 0, 0, w, h);
    if (maskOk) {
      applyMaskedChromaStripOnly(ctx, w, h, mask);
    } else {
      applyFullCanvasLuminanceInPlace(ctx, w, h);
    }
  }
  let garmentSnap = null;
  if (
    design?.complete &&
    design.naturalWidth &&
    state.designFabricBlend > 0.005
  ) {
    garmentSnap = ctx.getImageData(0, 0, w, h);
  }
  drawDesignWithFabricBlend(ctx, w, h, design, garmentSnap);
  if (productShot && maskOk) {
    const mAlpha = getMaskAlphaPlaneScaled(mask, w, h);
    applyPureWhiteBackdropSanitize(ctx, w, h, mAlpha);
  }
  if (!productShot && maskOk && state.contactShadowEnabled) {
    const { r: br, g: bg, b: bb } = parseHexRgb(sceneHex);
    if (luminanceRgb(br, bg, bb) > 246) {
      drawCatalogContactShadow(
        ctx,
        w,
        h,
        mask,
        state.alphaCutoutGarmentMask ? 0.52 : 1
      );
    }
  }
  if (!productShot && maskOk) {
    applyStudioPhotorealFinish(ctx, w, h, mask, sceneHex);
  }
}

/**
 * Recolor: identical neutral-base preparation, then luminance-matched swatch on that grayscale garment.
 * Soft-mask alpha composites toward scene so antialiased edges don’t read as an opaque colored halo.
 */
function applyMaskedSolidFill(ctx, w, h, garmentHex, maskNatCanvas, sceneHex) {
  const { r: tr, g: tg, b: tb } = parseHexRgb(garmentHex);
  const tintHsl = rgb8ToHsl(tr, tg, tb);
  const tintLab = srgb8RgbToLab(tr, tg, tb);
  const { r: bgR, g: bgG, b: bgB } = parseHexRgb(sceneHex);
  const { imgData, d, alphaRaw, alphaE, alphaNeighborMax, n, chromaKeyHint } =
    prepareMaskedNeutralBasePixels(ctx, w, h, maskNatCanvas);

  const lumTarget =
    0.2126 * tr + 0.7152 * tg + 0.0722 * tb;
  const denom = Math.max(lumTarget, 14);
  /** Fold range: tight enough to avoid fake “radial” glow, wide enough for fabric micro-shade. */
  const kMax = 1.07;
  const kMin = 0.11;
  const lumGamma = 0.99;
  const tex = Math.max(0, Math.min(0.55, state.texturePreserve));
  const sceneBright = luminanceRgb(bgR, bgG, bgB) > 236;
  const dfUser = Math.max(0, Math.min(1, state.defringeStrength));
  const trMax = Math.max(tr, tg, tb);
  /**
   * Maroon / burgundy / brick (e.g. #6b1c2e) must count as red — not only bright tr>165 — or the red-spike
   * reducer fights the swatch and fringe logic never matches “red on red” catalog cases.
   */
  const targetIsRedDominant =
    (tr > 165 && tr >= Math.max(tg, tb) - 20) ||
    (tr >= trMax - 14 && tr > tg + 8 && tr > tb + 4 && tr > 36);
  /**
   * Forest / bottle / olive greens (e.g. #3d6b4a) must count as green — not only neon tg>165 — or the
   * “green spike” reducer mutes the swatch and mint/cyan fringe handling never arms.
   */
  const targetIsGreenDominant =
    (tg > 165 && tg >= Math.max(tr, tb) - 20) ||
    (tg >= Math.max(tr, tb) - 14 && tg > tr + 10 && tg > 34);
  /**
   * Mint / sage / pastel greens (high swatch luminance). Forest-green fringe math (very low softCeil)
   * was crushing luma in the AA band → dark green “stroke” on white; gBoost also started at rawA 22,
   * leaving the outermost pixels stuck on that dark k.
   */
  const lightGreenSwatch = targetIsGreenDominant && lumTarget > 148;
  const extRedOnWhite =
    state.externalMaskActive &&
    targetIsRedDominant &&
    sceneBright &&
    !targetIsGreenDominant;
  /**
   * Red swatch + bright backdrop: pulling the AA band toward pure red reads as a neon “stroke” vs body.
   * Prefer scene (white) in the fringe for any mask source — same garment photo on black → red outline bug.
   */
  const redSwatchOnWhite =
    sceneBright && targetIsRedDominant && !targetIsGreenDominant;
  /**
   * Green + bright backdrop: outer AA was getting full swatch chroma while inner rim stayed dark matting
   * → visible “two tones” (dark line + green ghost). Same idea as redSwatchOnWhite — bias fringe toward scene.
   */
  const greenSwatchOnWhite = sceneBright && targetIsGreenDominant;
  let df = dfUser;
  if (extRedOnWhite) df = Math.min(1, dfUser + 0.2);
  /** Narrow band of true anti-alias fringe — not interior highlights with medium alpha. */
  const fringeAlphaMax = 92;
  /** Low floor on red+white: outer defringe toward swatch *is* the red halo; other swatches keep stronger pull. */
  const outerDefringeFloor = redSwatchOnWhite
    ? 0.26
    : greenSwatchOnWhite
      ? lightGreenSwatch
        ? 0.34
        : 0.28
      : extRedOnWhite
        ? 0.72
        : 0.62;
  /** Less source texture in AA when red on white — photo red + tint red stacks as a hot rim. */
  const texEff = extRedOnWhite || redSwatchOnWhite
    ? Math.max(0, tex * (extRedOnWhite ? 0.72 : 0.62))
    : sceneBright && targetIsGreenDominant
      ? Math.min(0.55, tex * 1.08)
      : tex;
  const hpAmt = 0.12;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rawA = alphaRaw[i];
    const ma = alphaE[i];
    const sr = d[o];
    const sg = d[o + 1];
    const sb = d[o + 2];
    const lumS = luminanceRgb(sr, sg, sb);

    if (
      sceneBright &&
      chromaKeyHint[i] &&
      rawA > 2 &&
      rawA < 252
    ) {
      d[o] = bgR;
      d[o + 1] = bgG;
      d[o + 2] = bgB;
      d[o + 3] = 255;
      continue;
    }

    /**
     * Only snap near-zero mask + very bright pixels to scene. A looser threshold carved “holes” in
     * hood highlights and ribbing where the mask is soft but still garment.
     */
    if (rawA < 9 && lumS > 232) {
      d[o] = bgR;
      d[o + 1] = bgG;
      d[o + 2] = bgB;
      d[o + 3] = 255;
      continue;
    }
    /**
     * True backdrop: mask nearly empty, no garment in 3×3, and pixel reads like studio white — not dark
     * hood / pocket interior (avoids white speckles inside the garment when the mask has small gaps).
     */
    if (rawA < 10 && alphaNeighborMax[i] < 20 && lumS > 218) {
      d[o] = bgR;
      d[o + 1] = bgG;
      d[o + 2] = bgB;
      d[o + 3] = 255;
      continue;
    }
    /**
     * Hood openings / matting gaps: bright red key shows through weak mask — paint scene, not scarlet.
     */
    if (
      sceneBright &&
      rawA < 62 &&
      sr > 118 &&
      sr > sg + 34 &&
      sr > sb + 34 &&
      lumS > 82 &&
      lumS < 252
    ) {
      d[o] = bgR;
      d[o + 1] = bgG;
      d[o + 2] = bgB;
      d[o + 3] = 255;
      continue;
    }
    /**
     * Prep used to skip desat for very low mask alpha — weak-mask hood kept capture chroma. Force luma
     * for texture / balance steps without changing luminance-based k.
     */
    const Lclamp = Math.round(Math.min(255, Math.max(0, lumS)));
    const srT = rawA < 12 ? Lclamp : sr;
    const sgT = rawA < 12 ? Lclamp : sg;
    const sbT = rawA < 12 ? Lclamp : sb;

    const lumAdjusted = Math.pow(lumS / 255, lumGamma) * 255;
    /**
     * Fringe pixels often still carry backdrop-bright luma after prep → huge k → light mint ring on dark swatches.
     * Clamp effective luminance in the soft-mask band so the rim stays deep like the body fabric.
     */
    let lumForTint = lumAdjusted;
    if (rawA < fringeAlphaMax) {
      const fe = 1 - smoothstep01(rawA / (fringeAlphaMax + 6));
      let softCeil = 108 + 62 * smoothstep01(rawA / fringeAlphaMax);
      /**
       * Forest / bottle greens: deep cap fights neon rims on **dark** catalog fabric. On **white**
       * flat-lays the fringe is still bright (shadow on white) — same cap forces a dark green ring.
       */
      if (sceneBright && targetIsGreenDominant && !lightGreenSwatch) {
        const softForest = 76 + 44 * smoothstep01(rawA / fringeAlphaMax);
        const softBrightGarment = 116 + 88 * smoothstep01(rawA / fringeAlphaMax);
        let wBright =
          lumS > 148 ? smoothstep01((lumS - 148) / 95) : 0;
        if (state.alphaCutoutGarmentMask && rawA < fringeAlphaMax) {
          const outerEdge = 1 - smoothstep01(rawA / fringeAlphaMax);
          wBright = Math.max(
            wBright,
            0.52 +
              0.4 * smoothstep01(rawA / fringeAlphaMax) +
              0.24 * outerEdge * smoothstep01((118 - lumS) / 95)
          );
          wBright = Math.min(1, wBright);
        }
        softCeil = softForest * (1 - wBright) + softBrightGarment * wBright;
      } else if (sceneBright && lightGreenSwatch) {
        /** Pastel greens: higher ceiling so fringe k doesn’t collapse to a dark “stroke” vs white. */
        softCeil = 162 + 68 * smoothstep01(rawA / fringeAlphaMax);
      } else if (sceneBright && targetIsRedDominant) {
        /** Deep reds: cap fringe luma so the rim isn’t neon / hot vs the body. */
        if (lumTarget < 100) {
          softCeil = extRedOnWhite
            ? 44 + 24 * smoothstep01(rawA / fringeAlphaMax)
            : 60 + 32 * smoothstep01(rawA / fringeAlphaMax);
        } else {
          softCeil = 78 + 46 * smoothstep01(rawA / fringeAlphaMax);
        }
      }
      lumForTint =
        lumAdjusted * (1 - fe) + Math.min(lumAdjusted, softCeil) * fe;
    }

    let k = Math.pow(Math.max(0, lumForTint) / 255, 1.2) * (255 / denom);
    const shadowW = 1 - smoothstep01((lumS - 24) / 56);
    const kFloor = Math.max(0.045, kMin * (1 - 0.55 * shadowW));
    k = Math.pow(Math.max(0.001, k), 1 + 0.34 * shadowW);
    k = Math.min(kMax, Math.max(kFloor, k));
    /** Preserve source lightness channel; apply tint in Lab chroma channels. */
    const srcLab = srgb8RgbToLab(srT, sgT, sbT);
    const Lgamma = Math.max(
      0,
      Math.min(100, 100 * Math.pow(Math.max(0.001, srcLab.L / 100), 1.2))
    );
    const shadowSat = lumS < 80 ? Math.max(0.28, 1 - 0.58 * shadowW) : 1;
    let labRgb = labToSrgb8(
      Lgamma,
      tintLab.a * shadowSat,
      tintLab.b * shadowSat
    );
    let rr = labRgb.r;
    let gg = labRgb.g;
    let bb = labRgb.b;
    /** Strict multiply for dark source luminance so shadows sit above tint naturally. */
    if (lumS < 100) {
      const mulW = 0.72 + 0.28 * (1 - smoothstep01((lumS - 18) / 82));
      const mr = (srT * tr) / 255;
      const mg = (sgT * tg) / 255;
      const mb = (sbT * tb) / 255;
      rr = Math.round(rr * (1 - mulW) + mr * mulW);
      gg = Math.round(gg * (1 - mulW) + mg * mulW);
      bb = Math.round(bb * (1 - mulW) + mb * mulW);
    }
    /** High-pass detail recovery (fabric weave/stitching) from source at ~12%. */
    const detailR = srT - lumS;
    const detailG = sgT - lumS;
    const detailB = sbT - lumS;
    rr = Math.round(Math.max(0, Math.min(255, rr + detailR * hpAmt)));
    gg = Math.round(Math.max(0, Math.min(255, gg + detailG * hpAmt)));
    bb = Math.round(Math.max(0, Math.min(255, bb + detailB * hpAmt)));
    if (rawA < 128) {
      const edgeT = 1 - smoothstep01(rawA / 128);
      const eh = rgb8ToHsl(rr, gg, bb);
      const sat = Math.max(0, eh.s * (1 - 0.38 * edgeT));
      const ergb = hslToRgb8(eh.h, sat, eh.l);
      rr = ergb.r;
      gg = ergb.g;
      bb = ergb.b;
    }
    const edgeBand = 1 - smoothstep01((rawA - 108) / 116);
    if (edgeBand > 0.001) {
      const srcEh = rgb8ToHsl(srT, sgT, sbT);
      const edgeSat = Math.max(0, srcEh.s * (1 - 0.9 * edgeBand));
      const srcEdgeRgb = hslToRgb8(srcEh.h, edgeSat, srcEh.l);
      const edgeBgPull = Math.min(0.96, 0.56 + 0.4 * edgeBand);
      rr = Math.round(rr * (1 - edgeBand) + (srcEdgeRgb.r * (1 - edgeBgPull) + bgR * edgeBgPull) * edgeBand);
      gg = Math.round(gg * (1 - edgeBand) + (srcEdgeRgb.g * (1 - edgeBgPull) + bgG * edgeBgPull) * edgeBand);
      bb = Math.round(bb * (1 - edgeBand) + (srcEdgeRgb.b * (1 - edgeBgPull) + bgB * edgeBgPull) * edgeBand);
    }

    if (!targetIsRedDominant && rr > gg + 28 && rr > bb + 28) {
      const rk = Math.min(1, (rr - Math.max(gg, bb)) / 72);
      rr = Math.round(rr * (1 - 0.62 * rk) + ((gg + bb) / 2) * (0.62 * rk));
    }
    if (!targetIsGreenDominant && gg > rr + 28 && gg > bb + 28) {
      const gk = Math.min(1, (gg - Math.max(rr, bb)) / 72);
      gg = Math.round(gg * (1 - 0.6 * gk) + ((rr + bb) / 2) * (0.6 * gk));
    }
    if (bb > rr + 32 && bb > gg + 32) {
      const bk = Math.min(1, (bb - Math.max(rr, gg)) / 72);
      bb = Math.round(bb * (1 - 0.58 * bk) + ((rr + gg) / 2) * (0.58 * bk));
    }

    if (texEff > 0.001) {
      let tw = texEff * smoothstep01(ma / 238);
      if (rawA < fringeAlphaMax) {
        tw *= 0.28 + 0.72 * smoothstep01(rawA / fringeAlphaMax);
      }
      /** Forest green: strong texture kill on dark fabric; keep more grain when fringe luma is still high. */
      if (sceneBright && targetIsGreenDominant && !lightGreenSwatch && rawA < 78) {
        const deepKill = 0.06 + 0.12 * smoothstep01(rawA / 78);
        const brightKill = 0.26 + 0.5 * smoothstep01(rawA / 78);
        const wk = lumS > 155 ? smoothstep01((lumS - 155) / 85) : 0;
        tw *= deepKill * (1 - wk) + brightKill * wk;
      } else if (sceneBright && lightGreenSwatch && rawA < 88) {
        tw *= 0.22 + 0.55 * smoothstep01(rawA / 88);
      } else if (
        sceneBright &&
        targetIsRedDominant &&
        !targetIsGreenDominant &&
        rawA < 95
      ) {
        if (lumTarget < 102 && rawA < 88) {
          tw *= 0.035 + 0.07 * smoothstep01(rawA / 88);
        } else {
          tw *= 0.07 + 0.14 * smoothstep01(rawA / 78);
        }
      }
      if (extRedOnWhite && rawA < 102) {
        tw *= 0.28 + 0.5 * smoothstep01(rawA / 102);
      }
      if (
        sceneBright &&
        state.maskHighKeyStudio &&
        lumTarget < 198 &&
        lumTarget > 85 &&
        !targetIsRedDominant &&
        !targetIsGreenDominant &&
        rawA < 92
      ) {
        tw *= 0.38 + 0.62 * smoothstep01(rawA / 92);
      }
      const lumTinted = luminanceRgb(rr, gg, bb);
      const lumPhoto = luminanceRgb(srT, sgT, sbT);
      const lumMix = lumTinted * (1 - tw) + lumPhoto * tw;
      const scale = lumMix / Math.max(lumTinted, 3);
      rr = Math.round(Math.min(255, Math.max(0, rr * scale)));
      gg = Math.round(Math.min(255, Math.max(0, gg * scale)));
      bb = Math.round(Math.min(255, Math.max(0, bb * scale)));
    }

    /**
     * Defringe: inner (slider-controlled) + outer silhouette (floor blend so 0% slider still cleans rims).
     */
    let edgeAmt = 0;
    if (df > 0.001 && ma < 252 && rawA >= 200) {
      edgeAmt = df * (1 - smoothstep01(ma / 255));
      if (lumS > 218) {
        edgeAmt *= Math.max(0, 1 - (lumS - 218) / 45);
      }
    }
    {
      const outerDf = Math.max(df, outerDefringeFloor);
      if (rawA >= 36 && rawA < 222 && ma < 254) {
        const outer =
          outerDf *
          0.78 *
          smoothstep01((216 - rawA) / 216) *
          (1 - smoothstep01(ma / 254));
        edgeAmt = Math.max(edgeAmt, outer);
      }
    }
    if (edgeAmt > 0.001) {
      if (redSwatchOnWhite && rawA < 118) {
        const s =
          (0.58 + 0.32 * smoothstep01((rawA - 8) / 110)) *
          (1 - smoothstep01(ma / 252));
        const wScene = edgeAmt * Math.min(1, Math.max(0, s));
        const wSw = edgeAmt - wScene;
        rr = Math.round(rr * (1 - edgeAmt) + tr * wSw + bgR * wScene);
        gg = Math.round(gg * (1 - edgeAmt) + tg * wSw + bgG * wScene);
        bb = Math.round(bb * (1 - edgeAmt) + tb * wSw + bgB * wScene);
      } else if (greenSwatchOnWhite && rawA < 128) {
        const s =
          (lightGreenSwatch ? 0.68 : 0.58) +
          (lightGreenSwatch ? 0.3 : 0.38) *
            smoothstep01((rawA - 4) / 120);
        const s2 = s * (1 - smoothstep01(ma / 252));
        const wScene = edgeAmt * Math.min(1, Math.max(0, s2));
        const wSw = edgeAmt - wScene;
        rr = Math.round(rr * (1 - edgeAmt) + tr * wSw + bgR * wScene);
        gg = Math.round(gg * (1 - edgeAmt) + tg * wSw + bgG * wScene);
        bb = Math.round(bb * (1 - edgeAmt) + tb * wSw + bgB * wScene);
      } else {
        rr = Math.round(rr * (1 - edgeAmt) + tr * edgeAmt);
        gg = Math.round(gg * (1 - edgeAmt) + tg * edgeAmt);
        bb = Math.round(bb * (1 - edgeAmt) + tb * edgeAmt);
      }
    }
    if (
      sceneBright &&
      targetIsGreenDominant &&
      !lightGreenSwatch &&
      rawA >= (lumS > 168 ? 8 : 22) &&
      rawA < fringeAlphaMax &&
      ma < 252
    ) {
      const g0 = lumS > 168 ? 8 : 22;
      const gBoost =
        (0.42 + 0.38 * df) *
        (1 - smoothstep01((rawA - g0) / (fringeAlphaMax - g0)));
      let ge = Math.min(0.92, gBoost);
      if (lumS > 168) {
        const core = smoothstep01((rawA - 12) / (fringeAlphaMax - 16));
        ge *= 0.32 + 0.68 * core * core;
      }
      /** Outermost AA: do not paint full bottle green — merges with dark matting line as a second “tune”. */
      if (greenSwatchOnWhite && rawA < 88) {
        const outerT = 1 - smoothstep01((rawA - 8) / 78);
        ge *= 0.06 + 0.94 * (1 - 0.94 * outerT);
      }
      rr = Math.round(rr * (1 - ge) + tr * ge);
      gg = Math.round(gg * (1 - ge) + tg * ge);
      bb = Math.round(bb * (1 - ge) + tb * ge);
    } else if (
      sceneBright &&
      targetIsRedDominant &&
      !targetIsGreenDominant &&
      rawA >= 22 &&
      rawA < fringeAlphaMax &&
      ma < 252
    ) {
      const r0 = lumTarget < 100 ? 0.48 : 0.4;
      const rBoost =
        (r0 + 0.36 * df) *
        (1 - smoothstep01((rawA - 22) / (fringeAlphaMax - 22)));
      let re = Math.min(lumTarget < 100 ? 0.93 : 0.9, rBoost);
      /** Core keeps swatch pull; outer fringe must not snap to full red or we get a “red stroke” on white. */
      if (redSwatchOnWhite) {
        const core = smoothstep01((rawA - 28) / (fringeAlphaMax - 28));
        re *= 0.12 + 0.88 * core * core;
      }
      rr = Math.round(rr * (1 - re) + tr * re);
      gg = Math.round(gg * (1 - re) + tg * re);
      bb = Math.round(bb * (1 - re) + tb * re);
    }

    const nMax = alphaNeighborMax[i];
    /** Bias alpha up when neighbors are solid garment — fills armpit/notch gaps without new UI. */
    const rawBoosted = Math.min(
      255,
      rawA + Math.round(0.11 * nMax * (1 - rawA / 255))
    );
    /** Power > 1 narrows the semi-transparent rim → crisper shirt vs backdrop (less “halo” width). */
    let pullBg = Math.pow(Math.max(0, 1 - rawBoosted / 255), 1.52);
    /** Was widening bright “fringe” everywhere; limit to true silhouette band. */
    if (lumS > 138 && rawA < fringeAlphaMax) {
      pullBg = Math.max(pullBg, 1 - Math.pow(rawBoosted / 255, 1.78));
    }
    if (rawA < fringeAlphaMax) {
      /** Don’t add extra white via edgeBoost when the swatch is already dark — it widens pale rims. */
      const darkSw = lumTarget < 112 ? 0.35 + 0.65 * (lumTarget / 112) : 1;
      const edgeBoost =
        smoothstep01((lumS - 148) / 82) * (1 - rawA / 255);
      pullBg = Math.min(1, pullBg + edgeBoost * 0.36 * darkSw);
      let hiRim =
        smoothstep01((lumS - 192) / 58) * (1 - rawA / 255);
      if (
        state.maskHighKeyStudio &&
        sceneBright &&
        lumTarget < 200 &&
        lumTarget > 95 &&
        !targetIsRedDominant &&
        !targetIsGreenDominant
      ) {
        hiRim *= 0.45;
      }
      pullBg = Math.min(1, pullBg + hiRim * 0.12 * darkSw);
    }
    if (lumS < 222) {
      let dimAtten = smoothstep01(lumS / 222);
      if (greenSwatchOnWhite && rawA < 90 && lumS < 138) {
        dimAtten = Math.max(
          dimAtten,
          0.52 + 0.44 * smoothstep01((rawA - 4) / 82)
        );
      }
      pullBg *= dimAtten;
    }
    /**
     * Dark swatches + white scene: the same semi-transparent edge reads as a wide tan/cream ring.
     * Tighten how much scene bleeds in when the target is low-luminance (brown, black, navy).
     */
    if (lumTarget < 78) {
      const darkEase = Math.max(0.38, Math.min(1, lumTarget / 78));
      pullBg *= 0.5 + 0.5 * darkEase;
      /** Near-black swatches: extra cut on white bleed (gray / cyan rim on white backdrops). */
      if (lumTarget < 48) {
        pullBg *= 0.72 + 0.28 * Math.max(0, Math.min(1, lumTarget / 48));
      }
    } else if (lumTarget < 138) {
      /** Mid-depth colors (forest green, burgundy, navy): less white scene in the AA band. */
      const u = (lumTarget - 78) / 60;
      let mid = 0.7 + 0.3 * Math.max(0, Math.min(1, u));
      /**
       * Greens on bright studio scenes: the old `mid *= ~0.82` for `sceneBright && targetIsGreenDominant`
       * throttled scene bleed in the AA band (same pixels as post-blend swatch snap) → double rim. Omit for green.
       */
      if (sceneBright && targetIsRedDominant && !targetIsGreenDominant) {
        if (!redSwatchOnWhite) {
          mid *= 0.84 + 0.16 * Math.max(0, Math.min(1, u));
        }
      }
      pullBg *= mid;
    }
    if (sceneBright && rawA > 4 && rawA < 100 && nMax > 120) {
      if (lumTarget < 52) {
        pullBg *= 0.55 + 0.45 * smoothstep01((rawA - 4) / 96);
      } else if (targetIsGreenDominant && lumTarget < 138) {
        pullBg *= greenSwatchOnWhite
          ? 0.86 + 0.14 * smoothstep01((rawA - 4) / 96)
          : 0.6 + 0.4 * smoothstep01((rawA - 4) / 96);
      } else if (
        targetIsRedDominant &&
        !targetIsGreenDominant &&
        lumTarget < 138
      ) {
        if (redSwatchOnWhite) {
          pullBg *= 0.9 + 0.1 * smoothstep01((rawA - 4) / 96);
        } else {
          pullBg *= 0.6 + 0.4 * smoothstep01((rawA - 4) / 96);
        }
      }
    }
    if (nMax > 168 && rawA < 88 && lumS < 252) {
      let pen = 0.38 + 0.62 * smoothstep01(rawA / 88);
      if (greenSwatchOnWhite) {
        pen = 0.66 + 0.34 * smoothstep01(rawA / 88);
      }
      pullBg *= pen;
    }
    /**
     * Near-white scene + semi-transparent mask: extra cut on background tint in the AA band (stops mint/teal rims).
     */
    if (sceneBright && rawA > 4 && rawA < 128) {
      let cut = 0.48 + 0.52 * smoothstep01((rawA - 4) / 124);
      if (lumTarget < 55) {
        cut = 0.34 + 0.66 * smoothstep01((rawA - 4) / 124);
      } else if (targetIsGreenDominant && lumTarget < 140) {
        cut = greenSwatchOnWhite
          ? 0.76 + 0.24 * smoothstep01((rawA - 4) / 124)
          : 0.38 + 0.62 * smoothstep01((rawA - 4) / 124);
      } else if (
        targetIsRedDominant &&
        !targetIsGreenDominant &&
        lumTarget < 140
      ) {
        cut = redSwatchOnWhite
          ? 0.82 + 0.18 * smoothstep01((rawA - 4) / 124)
          : 0.39 + 0.61 * smoothstep01((rawA - 4) / 124);
      }
      pullBg *= cut;
    }
    if (
      (extRedOnWhite || redSwatchOnWhite) &&
      rawA > 5 &&
      rawA < fringeAlphaMax
    ) {
      const rimBoost =
        1.12 + 0.08 * (1 - smoothstep01((rawA - 5) / (fringeAlphaMax - 5)));
      pullBg = Math.min(1, pullBg * rimBoost);
    }
    if (greenSwatchOnWhite && rawA > 5 && rawA < fringeAlphaMax) {
      const gRim =
        1.04 +
        0.14 * (1 - smoothstep01((rawA - 5) / (fringeAlphaMax - 5)));
      pullBg = Math.min(1, pullBg * gRim);
    }
    /**
     * High-key studio + white scene: behavior splits by swatch luminance.
     * — Light / white garments: preserve the neutral gray drop-shadow band (don’t wash to flat white).
     * — Mid / deep swatches (tan, rust, forest, etc.): outer fringe was picking up swatch chroma on
     *   achromatic shadow pixels — pull harder toward scene there to kill the colored “halo”.
     */
    if (sceneBright && state.maskHighKeyStudio && !redSwatchOnWhite) {
      if (lumTarget > 212 && !lightGreenSwatch) {
        if (
          !state.pureWhiteProductMode &&
          lumS >= 158 &&
          lumS <= 244 &&
          rawA >= 14 &&
          rawA < fringeAlphaMax
        ) {
          const midL = 200;
          const shadowWeight =
            1 - Math.min(1, Math.abs(lumS - midL) / 80);
          if (shadowWeight > 0.04) {
            pullBg *= 1 - 0.28 * shadowWeight;
          }
        }
      } else if (
        !targetIsRedDominant &&
        (lightGreenSwatch ||
          (!targetIsGreenDominant && lumTarget < 205) ||
          (state.maskHighKeyStudio && targetIsGreenDominant))
      ) {
        if (
          lumS >= 158 &&
          lumS <= 238 &&
          rawA >= 5 &&
          rawA < 92
        ) {
          const outerT = smoothstep01((92 - rawA) / 87);
          const grayBand =
            smoothstep01((lumS - 156) / 78) *
            (1 - smoothstep01((lumS - 234) / 28));
          const haloFix = outerT * grayBand;
          if (haloFix > 0.035) {
            pullBg = Math.min(1, pullBg * (1 + 0.55 * haloFix));
          }
        }
        if (
          lumS >= 168 &&
          lumS <= 248 &&
          rawA >= 6 &&
          rawA < 58 &&
          nMax < 132
        ) {
          const cornerT =
            smoothstep01((58 - rawA) / 52) *
            smoothstep01((132 - nMax) / 132);
          if (cornerT > 0.06) {
            pullBg = Math.min(1, pullBg * (1 + 0.35 * cornerT));
          }
        }
      }
    }
    if (
      state.alphaCutoutGarmentMask &&
      sceneBright &&
      targetIsGreenDominant &&
      rawA > 4 &&
      rawA < fringeAlphaMax &&
      lumS < 120
    ) {
      const mat =
        smoothstep01((120 - lumS) / 100) *
        smoothstep01((fringeAlphaMax - rawA) / fringeAlphaMax);
      pullBg = Math.min(1, pullBg + 0.22 * mat);
    }
    if (rawA >= 26 && rawA <= 204 && ma < 250) {
      const edgeW = 1 - smoothstep01((rawA - 26) / 178);
      pullBg = Math.max(pullBg, 0.82 + 0.18 * edgeW);
    }
    const wf = 1 - pullBg;
    let or = Math.round(rr * wf + bgR * pullBg);
    let og = Math.round(gg * wf + bgG * pullBg);
    let ob = Math.round(bb * wf + bgB * pullBg);
    /** Cyan/teal JPEG or matting in the fringe: cap blue; also tame green-only spikes vs red (mint rim). */
    if (rawA < fringeAlphaMax) {
      let t = 0.72 * (1 - smoothstep01(rawA / fringeAlphaMax));
      if (lumTarget < 55) {
        t = Math.min(0.94, t + 0.22 * (1 - smoothstep01(rawA / fringeAlphaMax)));
      } else if (targetIsGreenDominant && sceneBright && lumTarget < 145) {
        t = Math.min(0.93, t + 0.2 * (1 - smoothstep01(rawA / fringeAlphaMax)));
      } else if (
        targetIsRedDominant &&
        !targetIsGreenDominant &&
        sceneBright &&
        lumTarget < 145
      ) {
        t = Math.min(0.92, t + 0.16 * (1 - smoothstep01(rawA / fringeAlphaMax)));
      }
      const bTh =
        lumTarget < 55
          ? 6
          : (targetIsGreenDominant || targetIsRedDominant) && sceneBright
            ? 5
            : 10;
      const bgTh =
        lumTarget < 55
          ? 5
          : (targetIsGreenDominant || targetIsRedDominant) && sceneBright
            ? 4
            : 8;
      if (ob > or + bTh && ob > og + bgTh) {
        const capPad =
          lumTarget < 55
            ? 4
            : (targetIsGreenDominant || targetIsRedDominant) && sceneBright
              ? 5
              : 8;
        const cap = Math.max(or, og) + capPad;
        ob = Math.round(ob * (1 - t) + Math.min(ob, cap) * t);
      }
      /**
       * Mint rim on non‑green swatches only. Must NOT run for forest / bottle green — og > or is expected
       * there; capping G here caused neon / teal halos on white backdrops.
       */
      const swatchGreenish =
        tg >= Math.max(tr, tb) - 15 && tg > 22;
      if (
        swatchGreenish &&
        !targetIsGreenDominant &&
        og > or + 14 &&
        og > ob + 6
      ) {
        const capG = Math.round((or + ob) / 2 + 18);
        og = Math.round(og * (1 - 0.45 * t) + Math.min(og, capG) * (0.45 * t));
      }
      /** Forest green on white: cyan rim (high B vs R). Skip pastel greens — cap flattens mint into gray. */
      if (
        targetIsGreenDominant &&
        sceneBright &&
        !lightGreenSwatch &&
        ob > or + 7 &&
        ob > Math.min(og, or) + 4
      ) {
        const tB = Math.min(0.88, t + 0.18 * (1 - smoothstep01(rawA / fringeAlphaMax)));
        const capB = Math.round(Math.max(or, og) + 10);
        ob = Math.round(ob * (1 - tB) + Math.min(ob, capB) * tB);
      }
      /** Maroon / burgundy on white: hot red rim (capture R + white) after scene blend. */
      if (
        targetIsRedDominant &&
        !targetIsGreenDominant &&
        sceneBright &&
        or > og + 6 &&
        or > ob + 6
      ) {
        const tR = Math.min(
          0.92,
          t +
            (lumTarget < 100 ? 0.28 : 0.2) *
              (1 - smoothstep01(rawA / fringeAlphaMax))
        );
        const capR = Math.round(
          Math.max(og, ob) + (lumTarget < 100 ? 5 : 12)
        );
        or = Math.round(or * (1 - tR) + Math.min(or, capR) * tR);
      }
    }
    /** Last-mile: collapse residual mint/green chroma in the outer AA for pastel swatches on white. */
    if (
      greenSwatchOnWhite &&
      lightGreenSwatch &&
      rawA > 3 &&
      rawA < 84
    ) {
      const Lout = luminanceRgb(or, og, ob);
      const chr = Math.max(or, og, ob) - Math.min(or, og, ob);
      if (og >= Math.max(or, ob) - 4 && chr > 4 && Lout < 234) {
        const rim =
          (1 - smoothstep01((rawA - 3) / 78)) *
          (1 - smoothstep01((Lout - 52) / 152));
        const u = Math.min(0.8, 0.16 + 0.64 * rim);
        or = Math.round(or * (1 - u) + bgR * u);
        og = Math.round(og * (1 - u) + bgG * u);
        ob = Math.round(ob * (1 - u) + bgB * u);
      }
    }
    if (
      sceneBright &&
      wf < (redSwatchOnWhite ? 0.17 : greenSwatchOnWhite ? 0.14 : 0.09)
    ) {
      or = bgR;
      og = bgG;
      ob = bgB;
    }
    /**
     * Green hue snap was strongest at *low* mask alpha — exactly where we already blended toward white.
     * Pastel greens on white: skip snap entirely (was re‑introducing the outer mint ring).
     */
    if (
      targetIsGreenDominant &&
      rawA > 3 &&
      rawA < 72 &&
      !(lightGreenSwatch && sceneBright)
    ) {
      const innerMin = sceneBright ? 48 : 3;
      const snapMax = sceneBright ? 0.34 : 0.62;
      if (rawA >= innerMin) {
        const Lout = luminanceRgb(or, og, ob);
        let kSnap = Lout / Math.max(lumTarget, 14);
        kSnap = Math.min(kMax, Math.max(kMin, kSnap));
        const span = Math.max(8, 72 - innerMin);
        const snap =
          (1 - smoothstep01((rawA - innerMin) / span)) * snapMax;
        const nr = Math.min(255, Math.round(tr * kSnap));
        const ng = Math.min(255, Math.round(tg * kSnap));
        const nb = Math.min(255, Math.round(tb * kSnap));
        or = Math.round(or * (1 - snap) + nr * snap);
        og = Math.round(og * (1 - snap) + ng * snap);
        ob = Math.round(ob * (1 - snap) + nb * snap);
      }
    } else if (
      sceneBright &&
      targetIsRedDominant &&
      !targetIsGreenDominant &&
      rawA > 3 &&
      !redSwatchOnWhite
    ) {
      const maroonDeep = lumTarget < 102;
      const rawSnapMax = maroonDeep ? 90 : 72;
      if (rawA < rawSnapMax) {
        const Lout = luminanceRgb(or, og, ob);
        let kSnap = Lout / Math.max(lumTarget, 14);
        kSnap = Math.min(kMax, Math.max(kMin, kSnap));
        const snap =
          (1 - smoothstep01(rawA / rawSnapMax)) * (maroonDeep ? 0.78 : 0.62);
        const nr = Math.min(255, Math.round(tr * kSnap));
        const ng = Math.min(255, Math.round(tg * kSnap));
        const nb = Math.min(255, Math.round(tb * kSnap));
        or = Math.round(or * (1 - snap) + nr * snap);
        og = Math.round(og * (1 - snap) + ng * snap);
        ob = Math.round(ob * (1 - snap) + nb * snap);
      }
    }
    d[o] = or;
    d[o + 1] = og;
    d[o + 2] = ob;
    d[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Studio ecommerce finish: top‑center key light + hem fill, collar inner depth, subtle cotton grain,
 * mild lighting asymmetry — all clipped to the garment mask (no outer glow, no halo past the silhouette).
 */
function applyStudioPhotorealFinish(ctx, w, h, maskNatCanvas, sceneHex) {
  if (
    !state.studioPhotorealFinish ||
    !maskNatCanvas?.width ||
    w < 48 ||
    h < 48
  ) {
    return;
  }
  const { r: br, g: bg, b: bb } = parseHexRgb(sceneHex);
  if (luminanceRgb(br, bg, bb) < 246) return;
  /**
   * LAB path: keep grain/collar (material + neck depth) but tame top soft-light — it was lifting AA pixels
   * and stacking with edge highlights → thick white halo vs reference mockups.
   */
  const finKey = state.labRecolorPipeline ? 0.38 : 1;
  const finCollar = state.labRecolorPipeline ? 0.62 : 1;
  const finGrain = state.labRecolorPipeline ? 0.78 : 1;

  const seed =
    (w * 73856093 + h * 19349663 + (state.baseNaturalW || w) * 97) >>> 0;
  const asymX = (((seed & 255) / 255 - 0.5) * w * 0.012) | 0;
  const asymSkew = ((seed >>> 8) & 255) / 255 - 0.5;

  const mc = maskNatCanvas.getContext("2d", { willReadFrequently: true });
  const mImg = mc.getImageData(0, 0, w, h);
  const md = mImg.data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (md[(row + x) * 4 + 3] > 18) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return;
  const bh = maxY - minY + 1;
  const cx = (minX + maxX) * 0.5 + asymX;

  const lightLayer = document.createElement("canvas");
  lightLayer.width = w;
  lightLayer.height = h;
  const Lc = lightLayer.getContext("2d");
  Lc.save();
  Lc.translate(cx, 0);
  Lc.transform(1, 0, asymSkew * 0.018, 1, -cx, 0);
  const gLight = Lc.createLinearGradient(0, 0, 0, h);
  /** Top-center key: slightly warmer highlight, stronger hem falloff for depth (studio reference). */
  gLight.addColorStop(0, "rgba(255, 250, 242, 0.2)");
  gLight.addColorStop(0.12, "rgba(255, 255, 255, 0.07)");
  gLight.addColorStop(0.42, "rgba(255, 255, 255, 0)");
  gLight.addColorStop(1, "rgba(22, 20, 18, 0.15)");
  Lc.fillStyle = gLight;
  Lc.fillRect(-w, 0, w * 3, h);
  Lc.restore();
  Lc.globalCompositeOperation = "destination-in";
  Lc.drawImage(maskNatCanvas, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = "soft-light";
  ctx.globalAlpha = 0.54 * finKey;
  ctx.drawImage(lightLayer, 0, 0);
  ctx.restore();

  const collarH = Math.max(10, Math.min(bh * 0.15, h * 0.2));
  const collarTop = minY;
  const collarLayer = document.createElement("canvas");
  collarLayer.width = w;
  collarLayer.height = h;
  const Cc = collarLayer.getContext("2d");
  const cg = Cc.createLinearGradient(
    0,
    collarTop,
    0,
    collarTop + collarH * 1.25
  );
  cg.addColorStop(0, "rgba(8, 7, 7, 0.42)");
  cg.addColorStop(0.38, "rgba(38, 34, 32, 0.14)");
  cg.addColorStop(1, "rgba(255, 255, 255, 0)");
  Cc.fillStyle = cg;
  Cc.fillRect(0, 0, w, h);
  Cc.globalCompositeOperation = "destination-in";
  Cc.drawImage(maskNatCanvas, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = 0.34 * finCollar;
  ctx.drawImage(collarLayer, 0, 0);
  ctx.restore();

  const tSize = 72;
  const grainTile = document.createElement("canvas");
  grainTile.width = tSize;
  grainTile.height = tSize;
  const gt = grainTile.getContext("2d");
  const gIm = gt.createImageData(tSize, tSize);
  const gdd = gIm.data;
  let gSeed = seed ^ 0x9e3779b9;
  for (let i = 0; i < gdd.length; i += 4) {
    gSeed = (Math.imul(gSeed, 1664525) + 1013904223) >>> 0;
    const n = (gSeed & 1023) / 1023;
    const v = Math.round(Math.min(255, Math.max(0, 120 + (n - 0.5) * 17)));
    gdd[i] = v;
    gdd[i + 1] = v;
    gdd[i + 2] = v;
    gdd[i + 3] = 255;
  }
  gt.putImageData(gIm, 0, 0);

  const grainFull = document.createElement("canvas");
  grainFull.width = w;
  grainFull.height = h;
  const gfc = grainFull.getContext("2d");
  gfc.imageSmoothingEnabled = true;
  gfc.imageSmoothingQuality = "high";
  const pat = gfc.createPattern(grainTile, "repeat");
  if (pat) {
    gfc.fillStyle = pat;
    gfc.save();
    gfc.translate(asymX * 1.5, asymSkew * h * 0.006);
    gfc.fillRect(-w, -h, w * 3, h * 3);
    gfc.restore();
    gfc.globalCompositeOperation = "destination-in";
    gfc.drawImage(maskNatCanvas, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.062 * finGrain;
    ctx.drawImage(grainFull, 0, 0);
    ctx.restore();
  }
}

function sceneIsBrightEnoughForShadow(hex, minL = 198) {
  const { r, g, b } = parseHexRgb(hex);
  return luminanceRgb(r, g, b) >= minL;
}

/**
 * Transparent PNG catalog: draw a blurred, offset silhouette **before** the base image so it shows through
 * clear pixels and sits under the garment (not a grey veil on top).
 */
function drawSilhouetteContactShadowBeforeBase(ctx, w, h, maskNatCanvas, sceneHex) {
  if (
    !state.contactShadowEnabled ||
    !maskNatCanvas?.width ||
    w < 32 ||
    h < 32
  ) {
    return;
  }
  if (!sceneIsBrightEnoughForShadow(sceneHex, 185)) return;
  /**
   * Full blurred silhouette read as a grey “orb” behind the shirt. Weight alpha toward the **lower garment**
   * so the cast reads like floor contact, not a halo around the whole outline.
   */
  const blurPx = Math.max(9, Math.min(38, Math.round(Math.min(w, h) * 0.032)));
  const offY = Math.max(2, Math.round(h * 0.018));
  const op = Math.max(0.06, Math.min(0.32, state.contactShadowOpacity)) * 0.78;
  const seed = (w * 17 + h * 31) % 503;
  const offX = Math.round(((seed % 37) - 18) * 0.09);
  const spread = 1.038 + (seed % 7) * 0.0014;

  const s = document.createElement("canvas");
  s.width = w;
  s.height = h;
  const sc = s.getContext("2d");
  sc.drawImage(maskNatCanvas, 0, 0, w, h);
  const sid = sc.getImageData(0, 0, w, h);
  const sd = sid.data;
  let minY = h;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (sd[(row + x) * 4 + 3] > 20) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxY < minY) return;
  const bh = Math.max(1, maxY - minY + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const gy = (y - minY) / bh;
    const wgt =
      gy < 0.38 ? 0 : smoothstep01((gy - 0.38) / 0.62);
    const wgt2 = wgt * wgt;
    for (let x = 0; x < w; x++) {
      const o = (row + x) * 4 + 3;
      sd[o] = Math.round(sd[o] * wgt2);
    }
  }
  sc.putImageData(sid, 0, 0);

  const sh = document.createElement("canvas");
  sh.width = w;
  sh.height = h;
  const shc = sh.getContext("2d");
  shc.save();
  shc.translate(w * 0.5, h * 0.985);
  shc.scale(spread, 1);
  shc.translate(-w * 0.5, -h * 0.985);
  shc.translate(offX, offY);
  shc.drawImage(s, 0, 0);
  shc.restore();
  shc.globalCompositeOperation = "source-in";
  shc.fillStyle = "#141210";
  shc.fillRect(0, 0, w, h);

  ctx.save();
  ctx.filter = `blur(${blurPx}px)`;
  ctx.globalAlpha = op;
  ctx.drawImage(sh, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Very light ground contact under the hem — enough to anchor the product, not a heavy “bar”.
 * @param {number} [hemStrength=1] — scale opacities (e.g. ~0.35 for PNG cutouts that already have a silhouette shadow).
 */
function drawCatalogContactShadow(ctx, w, h, maskNatCanvas, hemStrength = 1) {
  if (!state.contactShadowEnabled || !maskNatCanvas?.width || w < 48 || h < 48) return;
  const hs = Math.max(0, Math.min(1.25, hemStrength));
  /** JPEG flat-lays rely on this pass for grounding (no under-layer silhouette). */
  const jBoost = hs >= 0.9 ? 1.42 : 1;
  /**
   * White-studio JPEGs already have a soft floor shadow — use a weaker hem pass so we still anchor the product
   * without doubling density (previously we skipped entirely and the shirt looked “floating”).
   */
  const hk = state.maskHighKeyStudio ? 0.52 : 1;
  const scaled = document.createElement("canvas");
  scaled.width = w;
  scaled.height = h;
  const sc = scaled.getContext("2d");
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(maskNatCanvas, 0, 0, w, h);
  const { data } = sc.getImageData(0, 0, w, h);
  let yBottom = -1;
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 36) {
        yBottom = y;
        break;
      }
    }
    if (yBottom >= 0) break;
  }
  if (yBottom < 0) return;

  const bandTop = Math.max(0, yBottom - Math.round(h * 0.16));
  const floorMask = document.createElement("canvas");
  floorMask.width = w;
  floorMask.height = h;
  const fm = floorMask.getContext("2d");
  const fImg = fm.createImageData(w, h);
  const fd = fImg.data;
  const floorAlphaCut = 72;
  for (let y = bandTop; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const o = i * 4;
      if (data[o + 3] < floorAlphaCut) {
        fd[o] = 255;
        fd[o + 1] = 255;
        fd[o + 2] = 255;
        fd[o + 3] = 255;
      }
    }
  }
  fm.putImageData(fImg, 0, 0);

  const shadow = document.createElement("canvas");
  shadow.width = w;
  shadow.height = h;
  const sh = shadow.getContext("2d");
  const asym = (((w * 13 + yBottom * 7) % 61) - 30) * 0.15;
  const cx = w * 0.5 + asym;
  const cy = yBottom + Math.max(4, h * 0.024);
  const rad = Math.max(w * 0.42, h * 0.3);
  const g = sh.createRadialGradient(cx, cy, 0, cx, cy, rad);
  const k0 = 0.1 * hk * hs * jBoost;
  const k1 = 0.042 * hk * hs * jBoost;
  const k2 = 0.016 * hk * hs * jBoost;
  g.addColorStop(0, `rgba(28, 25, 23, ${k0})`);
  g.addColorStop(0.4, `rgba(28, 25, 23, ${k1})`);
  g.addColorStop(0.74, `rgba(28, 25, 23, ${k2})`);
  g.addColorStop(1, "rgba(28, 25, 23, 0)");
  sh.fillStyle = g;
  sh.fillRect(0, 0, w, h);
  sh.globalCompositeOperation = "destination-in";
  sh.drawImage(floorMask, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  const inset = 2;
  if (w > inset * 2 + 4 && h > inset * 2 + 4) {
    ctx.beginPath();
    ctx.rect(inset, 0, w - inset * 2, h);
    ctx.clip();
  }
  ctx.drawImage(shadow, 0, 0);
  ctx.restore();
}

/** Fallback if mask missing: solid fill over entire composite (including backdrop). */
function applyFullImageSolidFill(ctx, garmentHex) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.save();
  ctx.fillStyle = garmentHex;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function getMaskAlphaPlaneScaled(maskNatCanvas, w, h) {
  const mc = document.createElement("canvas");
  mc.width = w;
  mc.height = h;
  const mctx = mc.getContext("2d");
  mctx.imageSmoothingEnabled = true;
  mctx.imageSmoothingQuality = "high";
  mctx.drawImage(maskNatCanvas, 0, 0, w, h);
  const data = mctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3];
  return alpha;
}

/**
 * Catalog / flat backdrop: **straight alpha** composite — no premultiplied RGB, no fringe blend toward white in
 * garment RGB. Opaque garment color = user tint (linear) × relative luminance Y from the **source** capture;
 * then `out = G·α + backdrop·(1−α)` in linear light. Edge AA comes only from mask α, not from mixing halos into G.
 */
function applyStraightAlphaTintOnWhite(
  ctx,
  w,
  h,
  garmentHex,
  maskNatCanvas,
  sceneHex,
  baseImage
) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(baseImage, 0, 0, w, h);
  const bd = tctx.getImageData(0, 0, w, h).data;
  const maskA = getMaskAlphaPlaneScaled(maskNatCanvas, w, h);
  const n = w * h;
  const alphaNeighborMax = computeAlphaNeighborMax(maskA, w, h);
  const maskEdgeGrad = computeMaskAlphaGradientMax(maskA, w, h, 1);
  const yNeighMax = computeLuminanceNeighborMaxLinear(bd, w, h);

  let yRef = 0.001;
  for (let i = 0; i < n; i++) {
    if (maskA[i] < 100) continue;
    const o = i * 4;
    const lr = linearFromSrgb8(bd[o]);
    const lg = linearFromSrgb8(bd[o + 1]);
    const lb = linearFromSrgb8(bd[o + 2]);
    const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    if (y > yRef) yRef = y;
  }
  yRef = Math.max(yRef, 0.042);

  const { r: tr, g: tg, b: tb } = parseHexRgb(garmentHex);
  const labT = srgb8RgbToLab(tr, tg, tb);
  const muted = labToSrgb8(labT.L, labT.a * 0.92, labT.b * 0.92);
  const tLinR = linearFromSrgb8(muted.r);
  const tLinG = linearFromSrgb8(muted.g);
  const tLinB = linearFromSrgb8(muted.b);

  const { r: bgR8, g: bgG8, b: bgB8 } = parseHexRgb(sceneHex);
  const bgLinR = linearFromSrgb8(bgR8);
  const bgLinG = linearFromSrgb8(bgG8);
  const bgLinB = linearFromSrgb8(bgB8);

  const img = ctx.getImageData(0, 0, w, h);
  const dd = img.data;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a0 = maskA[i];
    let aComp = a0;
    const nmax = alphaNeighborMax[i];
    if (aComp < 36 && nmax > aComp + 8) {
      aComp = Math.min(252, Math.max(aComp, nmax - 16));
    }
    let af = aComp / 255;
    if (a0 < 40 && maskEdgeGrad[i] >= 16) {
      const floorAf = Math.max(
        aComp / 255,
        Math.min(1, (Math.max(aComp, nmax - 22) / 255) * 0.92)
      );
      af = Math.max(af, floorAf);
    }
    if (af < 1e-5) continue;

    const lr = linearFromSrgb8(bd[o]);
    const lg = linearFromSrgb8(bd[o + 1]);
    const lb = linearFromSrgb8(bd[o + 2]);
    const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    let k = y / yRef;
    const yN = yNeighMax[i];
    if (yN > y + 0.04 && y < yRef * 0.62 && a0 > 14) {
      const seamLift =
        smoothstep01((yN - y) / 0.22) *
        smoothstep01((yRef * 0.58 - y) / Math.max(0.08, yRef * 0.48));
      k = k + (Math.min(1.15, yN / yRef) - k) * (0.38 + 0.42 * seamLift);
    }
    k = Math.max(0.05, Math.min(1.3, k));

    const Gr = tLinR * k;
    const Gg = tLinG * k;
    const Gb = tLinB * k;

    const orLin = Gr * af + bgLinR * (1 - af);
    const ogLin = Gg * af + bgLinG * (1 - af);
    const obLin = Gb * af + bgLinB * (1 - af);

    dd[o] = srgb8ChannelFromLinear(orLin);
    dd[o + 1] = srgb8ChannelFromLinear(ogLin);
    dd[o + 2] = srgb8ChannelFromLinear(obLin);
    dd[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** Same as tint path but G = base_linear × tint_linear (dye multiply); still straight-α onto backdrop. */
function applyStraightAlphaMultiplyOnWhite(
  ctx,
  w,
  h,
  garmentHex,
  maskNatCanvas,
  sceneHex,
  baseImage
) {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(baseImage, 0, 0, w, h);
  const bd = tctx.getImageData(0, 0, w, h).data;
  const maskA = getMaskAlphaPlaneScaled(maskNatCanvas, w, h);
  const n = w * h;
  const alphaNeighborMax = computeAlphaNeighborMax(maskA, w, h);
  const maskEdgeGrad = computeMaskAlphaGradientMax(maskA, w, h, 1);

  const { r: tr0, g: tg0, b: tb0 } = parseHexRgb(garmentHex);
  const labT = srgb8RgbToLab(tr0, tg0, tb0);
  const muted = labToSrgb8(labT.L, labT.a * 0.9, labT.b * 0.9);
  const tLinR = linearFromSrgb8(muted.r);
  const tLinG = linearFromSrgb8(muted.g);
  const tLinB = linearFromSrgb8(muted.b);

  const { r: bgR8, g: bgG8, b: bgB8 } = parseHexRgb(sceneHex);
  const bgLinR = linearFromSrgb8(bgR8);
  const bgLinG = linearFromSrgb8(bgG8);
  const bgLinB = linearFromSrgb8(bgB8);

  const img = ctx.getImageData(0, 0, w, h);
  const dd = img.data;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a0 = maskA[i];
    let aComp = a0;
    const nmax = alphaNeighborMax[i];
    if (aComp < 36 && nmax > aComp + 8) {
      aComp = Math.min(252, Math.max(aComp, nmax - 16));
    }
    let af = aComp / 255;
    if (a0 < 40 && maskEdgeGrad[i] >= 16) {
      const floorAf = Math.max(
        aComp / 255,
        Math.min(1, (Math.max(aComp, nmax - 22) / 255) * 0.92)
      );
      af = Math.max(af, floorAf);
    }
    if (af < 1e-5) continue;

    const lr = linearFromSrgb8(bd[o]);
    const lg = linearFromSrgb8(bd[o + 1]);
    const lb = linearFromSrgb8(bd[o + 2]);

    const Gr = Math.min(1, lr * tLinR);
    const Gg = Math.min(1, lg * tLinG);
    const Gb = Math.min(1, lb * tLinB);

    const orLin = Gr * af + bgLinR * (1 - af);
    const ogLin = Gg * af + bgLinG * (1 - af);
    const obLin = Gb * af + bgLinB * (1 - af);

    dd[o] = srgb8ChannelFromLinear(orLin);
    dd[o + 1] = srgb8ChannelFromLinear(ogLin);
    dd[o + 2] = srgb8ChannelFromLinear(obLin);
    dd[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Catalog / pure-white mode: photo still contains floor shadow, vignette, and gray AA in soft-mask pixels.
 * Snap those toward #FFFFFF after recolor so the export matches a clean cutout (not a mockup scene).
 */
function applyPureWhiteBackdropSanitize(ctx, w, h, maskAlpha) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const nh = h;
  const aNeighMax = computeAlphaNeighborMax(maskAlpha, w, h);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const ma = maskAlpha[i];
    if (ma < 24) {
      if (aNeighMax[i] < 26) {
        d[o] = 255;
        d[o + 1] = 255;
        d[o + 2] = 255;
      }
      continue;
    }
    const r = d[o];
    const g = d[o + 1];
    const b = d[o + 2];
    const lum = luminanceRgb(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const y = Math.floor(i / w);
    const yNorm = nh > 1 ? y / (nh - 1) : 0;
    const bottomStrip =
      yNorm >= 0.68 ? smoothstep01((yNorm - 0.68) / 0.32) : 0;

    let bleach = 0;
    /**
     * Mustard / yellow AA often has chroma 30–45 and lum 210–245 — old test bleached it → pale halo.
     * Only treat as gray fringe when chroma is low or luminance is clearly shadow/mud.
     */
    if (ma < 52 && chroma < 32 && lum < 228) {
      const outer = 1 - smoothstep01((ma - 24) / 28);
      const gray = 1 - smoothstep01((lum - 175) / 78);
      bleach = Math.min(1, 0.92 * outer * gray);
    } else if (ma < 90 && bottomStrip > 0.08 && lum < 212 && chroma < 50) {
      const outer = 1 - smoothstep01((ma - 30) / 60);
      bleach = Math.min(
        1,
        0.78 *
          outer *
          bottomStrip *
          (1 - smoothstep01((lum - 195) / 50))
      );
    }
    if (lum < 188 && ma < 78 && chroma < 46) {
      bleach = Math.min(
        1,
        Math.max(bleach, 0.55 * (1 - smoothstep01((ma - 24) / 54)))
      );
    }
    /**
     * Dark outline only (lum well below a bright shirt body). Avoid bleaching medium-bright edge yellow → cream halo.
     */
    if (ma >= 24 && ma < 104 && lum < 198 && lum > 35) {
      const outer = 1 - smoothstep01((ma - 24) / 80);
      const notBodyHighlight = 1 - smoothstep01((lum - 168) / 38);
      const extra = 0.82 * outer * notBodyHighlight;
      if (extra > 0.06) {
        bleach = Math.min(1, Math.max(bleach, extra));
      }
    }
    if (bleach < 0.05) continue;
    d[o] = Math.round(r + (255 - r) * bleach);
    d[o + 1] = Math.round(g + (255 - g) * bleach);
    d[o + 2] = Math.round(b + (255 - b) * bleach);
  }
  ctx.putImageData(img, 0, 0);
}

function renderComposite(target, baseImage, sceneHex, garmentHex, design) {
  const w = target.width;
  const h = target.height;
  const ctx = target.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = sceneHex;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const maskOk =
    state.garmentMaskCanvas &&
    state.garmentMaskCanvas.width > 0 &&
    state.garmentMaskCanvas.width === baseImage.naturalWidth &&
    state.garmentMaskCanvas.height === baseImage.naturalHeight;

  const productShot = state.pureWhiteProductMode;

  if (
    !productShot &&
    garmentHex &&
    maskOk &&
    state.alphaCutoutGarmentMask &&
    state.contactShadowEnabled
  ) {
    drawSilhouetteContactShadowBeforeBase(
      ctx,
      w,
      h,
      state.garmentMaskCanvas,
      sceneHex
    );
  }

  const useMultiply =
    Boolean(garmentHex) &&
    maskOk &&
    state.multiplyTintRecolor &&
    baseImage?.naturalWidth > 0;

  const useLab =
    Boolean(garmentHex) &&
    maskOk &&
    state.labRecolorPipeline &&
    !state.multiplyTintRecolor &&
    baseImage?.naturalWidth > 0;

  if (useMultiply) {
    if (productShot) {
      applyStraightAlphaMultiplyOnWhite(
        ctx,
        w,
        h,
        garmentHex,
        state.garmentMaskCanvas,
        sceneHex,
        baseImage
      );
    } else {
      applyMaskedMultiplyRecolor(
        ctx,
        w,
        h,
        garmentHex,
        state.garmentMaskCanvas,
        sceneHex,
        baseImage
      );
    }
  } else if (useLab) {
    if (productShot) {
      applyStraightAlphaTintOnWhite(
        ctx,
        w,
        h,
        garmentHex,
        state.garmentMaskCanvas,
        sceneHex,
        baseImage
      );
    } else {
      applyMaskedLabRecolor(
        ctx,
        w,
        h,
        garmentHex,
        state.garmentMaskCanvas,
        sceneHex,
        baseImage
      );
    }
  } else if (garmentHex) {
    ctx.drawImage(baseImage, 0, 0, w, h);
    if (maskOk) {
      applyMaskedSolidFill(
        ctx,
        w,
        h,
        garmentHex,
        state.garmentMaskCanvas,
        sceneHex
      );
    } else {
      applyFullImageSolidFill(ctx, garmentHex);
    }
  } else {
    ctx.drawImage(baseImage, 0, 0, w, h);
  }

  let garmentSnap = null;
  if (
    design?.complete &&
    design.naturalWidth &&
    state.designFabricBlend > 0.005
  ) {
    garmentSnap = ctx.getImageData(0, 0, w, h);
  }
  drawDesignWithFabricBlend(ctx, w, h, design, garmentSnap);

  /**
   * Catalog white: snap residual shadow / matting. Neighbor-gated so thin mask dips next to solid garment are not
   * blasted to #fff (that caused white seam streaks with straight-α recolor).
   */
  if (productShot && maskOk && garmentHex && !useMultiply) {
    const mAlpha = getMaskAlphaPlaneScaled(state.garmentMaskCanvas, w, h);
    applyPureWhiteBackdropSanitize(ctx, w, h, mAlpha);
  }
  if (productShot && maskOk && garmentHex) {
    applyCatalogProductEnhance(
      ctx,
      w,
      h,
      state.garmentMaskCanvas,
      sceneHex,
      garmentHex
    );
  }

  if (
    !productShot &&
    garmentHex &&
    maskOk &&
    state.contactShadowEnabled
  ) {
    const { r: br, g: bg, b: bb } = parseHexRgb(sceneHex);
    if (luminanceRgb(br, bg, bb) > 246) {
      const hemFactor = state.alphaCutoutGarmentMask ? 0.52 : 1;
      drawCatalogContactShadow(
        ctx,
        w,
        h,
        state.garmentMaskCanvas,
        hemFactor
      );
    }
  }

  if (!productShot && maskOk) {
    applyStudioPhotorealFinish(ctx, w, h, state.garmentMaskCanvas, sceneHex);
  }

  const { r: er2, g: eg2, b: eb2 } = parseHexRgb(sceneHex);
  if (
    !productShot &&
    luminanceRgb(er2, eg2, eb2) > 248 &&
    w > 6 &&
    h > 6
  ) {
    ctx.save();
    ctx.fillStyle = sceneHex;
    const b = 3;
    ctx.fillRect(0, 0, w, b);
    ctx.fillRect(0, h - b, w, b);
    ctx.fillRect(0, 0, b, h);
    ctx.fillRect(w - b, 0, b, h);
    ctx.restore();
  }
}

function fitCanvasToImage() {
  if (!state.baseImg) return;
  const maxSide = 1000;
  let nw = state.baseNaturalW;
  let nh = state.baseNaturalH;
  const s = Math.min(1, maxSide / Math.max(nw, nh));
  nw = Math.round(nw * s);
  nh = Math.round(nh * s);
  els.previewCanvas.width = nw;
  els.previewCanvas.height = nh;
}

let _garmentPreviewCacheCanvas = null;
let _previewDragRafId = 0;
let _wheelFullRedrawTimer = 0;

function garmentPreviewCacheFingerprint(w, h) {
  const g = previewGarmentEntry();
  return JSON.stringify({
    pm: state.previewMode,
    w,
    h,
    bg: getEffectiveBackgroundHex(),
    gh: g?.hex ?? null,
    gid: g?.id ?? null,
    mg: state.maskGeneration,
    mt: state.maskTolerance,
    tp: state.texturePreserve,
    df: state.defringeStrength,
    pwp: state.pureWhiteProductMode,
    lab: state.labRecolorPipeline,
    mtint: state.multiplyTintRecolor,
    acm: state.alphaCutoutGarmentMask,
    cse: state.contactShadowEnabled,
    spf: state.studioPhotorealFinish,
  });
}

function getGarmentPreviewCacheCanvas(w, h) {
  if (!_garmentPreviewCacheCanvas) {
    _garmentPreviewCacheCanvas = document.createElement("canvas");
  }
  if (_garmentPreviewCacheCanvas.width !== w || _garmentPreviewCacheCanvas.height !== h) {
    _garmentPreviewCacheCanvas.width = w;
    _garmentPreviewCacheCanvas.height = h;
  }
  return _garmentPreviewCacheCanvas;
}

/** Renders garment + recolor without design — used to speed up drag / scale. */
function rebuildGarmentPreviewCache(w, h) {
  const cache = getGarmentPreviewCacheCanvas(w, h);
  if (state.previewMode === "recolor") {
    const garment = previewGarmentEntry();
    renderComposite(
      cache,
      state.baseImg,
      getEffectiveBackgroundHex(),
      garment ? garment.hex : null,
      null
    );
  } else if (state.previewMode === "neutral") {
    renderNeutralBasePreview(cache, state.baseImg, getEffectiveBackgroundHex(), null);
  } else {
    renderComposite(
      cache,
      state.baseImg,
      getEffectiveBackgroundHex(),
      previewGarmentEntry()?.hex ?? null,
      null
    );
  }
  state.garmentPreviewCacheFp = garmentPreviewCacheFingerprint(w, h);
  return cache;
}

function ensureGarmentPreviewCache(w, h) {
  const fp = garmentPreviewCacheFingerprint(w, h);
  if (
    state.garmentPreviewCacheFp === fp &&
    _garmentPreviewCacheCanvas &&
    _garmentPreviewCacheCanvas.width === w &&
    _garmentPreviewCacheCanvas.height === h
  ) {
    return getGarmentPreviewCacheCanvas(w, h);
  }
  return rebuildGarmentPreviewCache(w, h);
}

/** Fast preview while moving/scaling design (skips full recolor + fabric blend each frame). */
function redrawPreviewFastDesign() {
  if (!state.baseImg) {
    drawEmptyPreview();
    return;
  }
  fitCanvasToImage();
  const w = els.previewCanvas.width;
  const h = els.previewCanvas.height;
  const cache = ensureGarmentPreviewCache(w, h);
  const ctx = previewCtx;
  ctx.drawImage(cache, 0, 0);
  const d = activePreviewDesign();
  if (d && state.designOverlayVisible) {
    drawDesignLayer(ctx, w, h, d, { blurPx: 0 });
  }
  syncPreviewOverlaySize();
  updatePreviewToolbarHint();
}

function schedulePreviewDragRedraw() {
  if (_previewDragRafId) return;
  _previewDragRafId = requestAnimationFrame(() => {
    _previewDragRafId = 0;
    redrawPreviewFastDesign();
  });
}

function schedulePreviewFullRedrawAfterWheel() {
  clearTimeout(_wheelFullRedrawTimer);
  _wheelFullRedrawTimer = setTimeout(() => {
    _wheelFullRedrawTimer = 0;
    redrawPreview();
  }, 120);
}

const EMPTY_PREVIEW_W = 640;
const EMPTY_PREVIEW_H = 640;

function syncPreviewOverlaySize() {
  const o = els.maskPaintOverlay;
  const c = els.previewCanvas;
  if (!o || !c) return;
  if (o.width !== c.width || o.height !== c.height) {
    o.width = c.width;
    o.height = c.height;
  }
  if (state.maskBrushMode === "off" || !state.baseImg) {
    o.getContext("2d").clearRect(0, 0, o.width, o.height);
  }
}

function updatePreviewToolbarHint() {
  const el = document.getElementById("previewToolbarHint");
  if (!el) return;
  if (state.maskBrushMode === "add") {
    el.textContent =
      "Mask +: paint shirt area to recolor — design drag paused";
  } else if (state.maskBrushMode === "remove") {
    el.textContent =
      "Mask −: paint skin, jeans, or print to exclude — design drag paused";
  } else if (!state.designOverlayVisible && anyDesignLoaded()) {
    el.textContent = "Design hidden on preview — use Show design or the sidebar checkbox";
  } else if (state.baseImg && !anyDesignLoaded()) {
    el.textContent = "Masked garment · colors follow the selected swatch";
  } else {
    el.textContent = "Drag design · scroll = scale";
  }
}

function drawEmptyPreview() {
  els.previewCanvas.width = EMPTY_PREVIEW_W;
  els.previewCanvas.height = EMPTY_PREVIEW_H;
  const ctx = previewCtx;
  ctx.fillStyle = "#f1f5f9";
  ctx.fillRect(0, 0, EMPTY_PREVIEW_W, EMPTY_PREVIEW_H);
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, EMPTY_PREVIEW_W - 2, EMPTY_PREVIEW_H - 2);
  ctx.fillStyle = "#475569";
  ctx.font = "600 17px DM Sans, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Garment preview", EMPTY_PREVIEW_W / 2, EMPTY_PREVIEW_H / 2 - 14);
  ctx.font = "400 14px DM Sans, system-ui, sans-serif";
  ctx.fillStyle = "#64748b";
  ctx.fillText("Upload a photo — we mask & recolor automatically", EMPTY_PREVIEW_W / 2, EMPTY_PREVIEW_H / 2 + 14);
  syncPreviewOverlaySize();
  updatePreviewToolbarHint();
}

function redrawPreview() {
  if (!state.baseImg) {
    drawEmptyPreview();
    return;
  }

  fitCanvasToImage();
  const w = els.previewCanvas.width;
  const h = els.previewCanvas.height;
  const ctx = previewCtx;

  if (state.previewMode === "original") {
    const sceneHex = getEffectiveBackgroundHex();
    const productShot = state.pureWhiteProductMode;
    ctx.fillStyle = sceneHex;
    ctx.fillRect(0, 0, w, h);
    const mask = state.garmentMaskCanvas;
    const maskOk =
      mask &&
      mask.width > 0 &&
      mask.width === state.baseImg.naturalWidth &&
      mask.height === state.baseImg.naturalHeight;
    if (
      !productShot &&
      maskOk &&
      state.alphaCutoutGarmentMask &&
      state.contactShadowEnabled
    ) {
      drawSilhouetteContactShadowBeforeBase(ctx, w, h, mask, sceneHex);
    }
    ctx.drawImage(state.baseImg, 0, 0, w, h);
    const d = activePreviewDesign();
    let garmentSnap = null;
    if (
      d?.complete &&
      d.naturalWidth &&
      state.designFabricBlend > 0.005
    ) {
      garmentSnap = ctx.getImageData(0, 0, w, h);
    }
    drawDesignWithFabricBlend(ctx, w, h, d, garmentSnap);
    if (!productShot && maskOk && state.contactShadowEnabled) {
      const { r: br, g: bg, b: bb } = parseHexRgb(sceneHex);
      if (luminanceRgb(br, bg, bb) > 246) {
        drawCatalogContactShadow(
          ctx,
          w,
          h,
          mask,
          state.alphaCutoutGarmentMask ? 0.52 : 1
        );
      }
    }
    if (!productShot && maskOk) {
      applyStudioPhotorealFinish(ctx, w, h, mask, sceneHex);
    }
    syncPreviewOverlaySize();
    updatePreviewToolbarHint();
    return;
  }

  if (state.previewMode === "neutral") {
    renderNeutralBasePreview(
      els.previewCanvas,
      state.baseImg,
      getEffectiveBackgroundHex(),
      activePreviewDesign()
    );
    syncPreviewOverlaySize();
    updatePreviewToolbarHint();
    return;
  }

  const garment = previewGarmentEntry();
  renderComposite(
    els.previewCanvas,
    state.baseImg,
    getEffectiveBackgroundHex(),
    garment ? garment.hex : null,
    activePreviewDesign()
  );
  syncPreviewOverlaySize();
  updatePreviewToolbarHint();
}

function afterBaseImageLoaded() {
  if (!state.baseImg) return;
  if (tryRestoreBundledDefaultMaskFromCache()) {
    state.garmentPreviewCacheFp = "";
    updateMaskPaintOverlayInteractivity();
    redrawPreview();
    return;
  }
  rebuildGarmentMask();
  updateMaskPaintOverlayInteractivity();
  redrawPreview();
  saveBundledDefaultMaskToCache();
}

function hexLuminance(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((x) => x + x).join("") : h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function isLoadedDesign(img) {
  return !!(img && img.complete && img.naturalWidth > 0);
}

/**
 * Chooses light- vs dark-slot artwork from garment swatch luminance (same rule as preset light/dark lists).
 * The UI loads a single file into the light slot — it is used for every export color; any legacy dark slot is cleared on upload.
 */
function designImageForGarmentHex(hex) {
  const hasL = isLoadedDesign(state.designLightImg);
  const hasD = isLoadedDesign(state.designDarkImg);
  if (!hasL && !hasD) return null;
  if (!hex) {
    if (hasL) return state.designLightImg;
    return hasD ? state.designDarkImg : null;
  }
  const lightGarment = hexLuminance(hex) > 0.42;
  if (lightGarment) {
    if (hasL) return state.designLightImg;
    return hasD ? state.designDarkImg : null;
  }
  if (hasD) return state.designDarkImg;
  return hasL ? state.designLightImg : null;
}

function revokeBaseLibraryUrl(url) {
  if (url && String(url).startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
  }
}

function defaultBaseGalleryEntries() {
  return DEFAULT_BASE_GALLERY.map((item, i) => ({
    id: `default-base-${i}`,
    file: null,
    url: item.path,
    name: item.name,
  }));
}

/** Clears the library and restores the three default shirt thumbnails (no pipeline). */
function seedDefaultBaseGallery() {
  for (const e of state.baseLibrary) {
    revokeBaseLibraryUrl(e.url);
  }
  clearBundledDefaultMaskCache();
  state.baseLibrary = defaultBaseGalleryEntries();
  state.activeBaseId = state.baseLibrary[0]?.id ?? null;
  renderBaseGallery();
}

/** Default three samples + load and mask the first. */
function bootstrapDefaultGarmentPhotos() {
  seedDefaultBaseGallery();
  const first = state.baseLibrary[0];
  if (first) activateBaseLibraryEntry(first.id);
}

function renderBaseGallery() {
  const host = els.baseGallery;
  if (!host) return;
  host.innerHTML = "";
  for (const entry of state.baseLibrary) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "base-gallery-thumb" + (entry.id === state.activeBaseId ? " is-active" : "");
    btn.title = entry.name || "Garment";
    const im = document.createElement("img");
    im.src = entry.url;
    im.alt = "";
    btn.appendChild(im);
    btn.addEventListener("click", () => activateBaseLibraryEntry(entry.id));
    host.appendChild(btn);
  }
}

function activateBaseLibraryEntry(id) {
  const entry = state.baseLibrary.find((e) => e.id === id);
  if (!entry) return;
  state.activeBaseId = id;
  renderBaseGallery();
  setStatus("Loading photo…", "");
  setAppLoading(true, { label: "Loading photo…" });
  const img = new Image();
  img.onload = () => {
    runBaseImagePipeline(entry.file, img);
  };
  img.onerror = () => {
    setAppLoading(false);
    setStatus("Could not load that photo.", "error");
  };
  img.src = entry.url;
}

function addBaseToLibrary(file) {
  const url = URL.createObjectURL(file);
  const id = `base-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = file.name || "Photo";
  state.baseLibrary.push({ id, file, url, name });
  while (state.baseLibrary.length > 10) {
    const old = state.baseLibrary.shift();
    revokeBaseLibraryUrl(old?.url);
  }
  state.activeBaseId = id;
  renderBaseGallery();
  return id;
}

/**
 * Shared: set dimensions, edge-based garment mask on the original photo (backdrop pixels stay as shot), preview.
 */
function runBaseImagePipeline(_file, img) {
  state.baseImg = img;
  state.baseNaturalW = img.naturalWidth;
  state.baseNaturalH = img.naturalHeight;
  state.usingDefaultBase = false;
  state.externalMaskActive = false;
  if (els.rembgMaskFile) els.rembgMaskFile.value = "";

  setAppLoading(true, { label: "Masking garment…" });
  requestAnimationFrame(() => {
    try {
      afterBaseImageLoaded();
    } finally {
      setAppLoading(false);
    }
  });
}

/** Returns normalized `#rrggbb` or null if invalid. */
function normalizeHex(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s[0] === "#") s = s.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    s = s
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toLowerCase()}`;
}

/** Background for render/export: exact #ffffff when the picker is near-white (stops banding vs edges). */
function getSceneHexForComposite() {
  const n = normalizeHex(els.sceneBg?.value) || "#ffffff";
  const { r, g, b } = parseHexRgb(n);
  if (r >= 247 && g >= 247 && b >= 247) return "#ffffff";
  return n;
}

/** Scene fill + fringe decontam target: locked to #FFFFFF in ecommerce product mode. */
function getEffectiveBackgroundHex() {
  if (state.pureWhiteProductMode) return "#ffffff";
  return getSceneHexForComposite();
}

function syncBackdropInactiveHint() {
  if (els.backdropInactiveHint) {
    els.backdropInactiveHint.hidden = !state.pureWhiteProductMode;
  }
}

function persistExportColors() {
  try {
    const focus = state.colors.find((c) => c.id === state.focusColorId);
    const payload = {
      v: 1,
      groupSwatchesByLuma: !!state.groupSwatchesByLuma,
      focusHex: focus ? normalizeHex(focus.hex) : null,
      colors: state.colors.map((c) => ({
        name: c.name,
        hex: normalizeHex(c.hex) || "#808080",
        selected: !!c.selected,
      })),
    };
    localStorage.setItem(EXPORT_COLORS_STORAGE_KEY, JSON.stringify(payload));
  } catch (_) {
    /* ignore quota / private mode */
  }
}

function initColorsPresetOnly() {
  const focusIdx = 0;
  state.colors = PRESET_COLORS.map((c, i) => ({
    ...c,
    id: `p-${i}`,
    selected: i === focusIdx,
  }));
  state.focusColorId = `p-${focusIdx}`;
  renderColorSwatches();
  updateColorNameLabel();
  persistExportColors();
}

/**
 * After loading swatches from disk, append any catalog presets missing by name so new app colors appear
 * without the user hitting Defaults (localStorage otherwise keeps an older short list).
 * @returns {boolean} true if any swatch was added
 */
function mergeMissingPresetExportColors() {
  const seen = new Set(
    state.colors.map((c) => c.name.trim().toLowerCase())
  );
  let added = false;
  for (const p of PRESET_COLORS) {
    const key = p.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hex = normalizeHex(p.hex);
    state.colors.push({
      id: "",
      name: p.name,
      hex: hex || "#808080",
      selected: false,
    });
    added = true;
  }
  if (!added) return false;
  state.colors = state.colors.map((c, i) => ({
    ...c,
    id: `s-${i}`,
  }));
  return true;
}

function initExportColorsFromDiskOrDefaults() {
  try {
    const raw = localStorage.getItem(EXPORT_COLORS_STORAGE_KEY);
    if (!raw) {
      initColorsPresetOnly();
      return;
    }
    const data = JSON.parse(raw);
    if (!data || data.v !== 1 || !Array.isArray(data.colors) || !data.colors.length) {
      initColorsPresetOnly();
      return;
    }
    state.groupSwatchesByLuma =
      data.groupSwatchesByLuma !== undefined ? !!data.groupSwatchesByLuma : true;
    if (els.groupExportSwatches) {
      els.groupExportSwatches.checked = state.groupSwatchesByLuma;
    }
    state.colors = data.colors.map((c, i) => {
      const hex = normalizeHex(c.hex);
      return {
        id: `s-${i}`,
        name: typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Color",
        hex: hex || "#808080",
        selected: !!c.selected,
      };
    });
    const mergedNew = mergeMissingPresetExportColors();
    const fh = data.focusHex ? normalizeHex(data.focusHex) : null;
    let focus = fh ? state.colors.find((c) => normalizeHex(c.hex) === fh) : null;
    if (!focus) focus = state.colors.find((c) => c.selected) ?? state.colors[0];
    state.focusColorId = focus ? focus.id : null;
    renderColorSwatches();
    updateColorNameLabel();
    if (mergedNew) persistExportColors();
  } catch {
    initColorsPresetOnly();
  }
}

function syncHexFieldFromPicker() {
  if (!els.customColorHex) return;
  els.customColorHex.value = els.customColor.value.toUpperCase();
  els.customColorHex.classList.remove("hex-invalid");
}

/**
 * Apply typed hex to the color input when valid; otherwise mark invalid or re-sync from picker if empty.
 */
function applyHexFromText() {
  if (!els.customColorHex) return;
  const trimmed = els.customColorHex.value.trim();
  const n = normalizeHex(trimmed);
  if (n) {
    els.customColor.value = n;
    els.customColorHex.value = n.toUpperCase();
    els.customColorHex.classList.remove("hex-invalid");
    return;
  }
  if (trimmed) {
    els.customColorHex.classList.add("hex-invalid");
    return;
  }
  els.customColorHex.value = els.customColor.value.toUpperCase();
  els.customColorHex.classList.remove("hex-invalid");
}

function effectiveHexForAdd() {
  const fromField = normalizeHex(els.customColorHex?.value);
  if (fromField) return fromField;
  return els.customColor.value;
}

/** Append the picker + hex (+ optional name) as a new export swatch. */
function addCustomExportColorToList() {
  applyHexFromText();
  const hex = effectiveHexForAdd();
  if (!normalizeHex(hex)) {
    setStatus("Enter a valid hex color (#RGB or #RRGGBB).", "error");
    return false;
  }
  const rawName = els.customColorName?.value?.trim() ?? "";
  const name =
    rawName.length > 0 ? rawName.slice(0, 80) : `Custom ${hex.toUpperCase()}`;
  const id = `c-${Date.now()}`;
  state.colors.push({
    id,
    name,
    hex,
    selected: true,
  });
  state.focusColorId = id;
  if (els.customColorName) els.customColorName.value = "";
  renderColorSwatches();
  updateColorNameLabel();
  redrawPreview();
  persistExportColors();
  return true;
}

function previewGarmentEntry() {
  const focus = state.colors.find((c) => c.id === state.focusColorId);
  if (focus && focus.selected) return focus;
  return state.colors.find((c) => c.selected) ?? null;
}

function activePreviewDesign() {
  if (!state.designOverlayVisible) return null;
  const g = previewGarmentEntry();
  return designImageForGarmentHex(g?.hex ?? null);
}

function anyDesignLoaded() {
  return isLoadedDesign(state.designLightImg) || isLoadedDesign(state.designDarkImg);
}

function updateColorNameLabel() {
  if (!els.colorNameDisplay) return;
  const g = previewGarmentEntry();
  els.colorNameDisplay.textContent = g ? g.name : "None selected";
}

function removeColorById(id) {
  const idx = state.colors.findIndex((c) => c.id === id);
  if (idx < 0) return;
  state.colors.splice(idx, 1);
  if (state.focusColorId === id) {
    const next =
      state.colors.find((x) => x.selected) ?? state.colors[0] ?? null;
    state.focusColorId = next ? next.id : null;
  }
  renderColorSwatches();
  updateColorNameLabel();
  redrawPreview();
  persistExportColors();
}

function createColorSwatchButton(c) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "color-swatch-btn";
  btn.title = `${c.name} — click to toggle export`;
  if (c.hex.toLowerCase() === "#ffffff") btn.classList.add("is-white");
  if (c.selected) btn.classList.add("is-selected");
  if (c.id === state.focusColorId) btn.classList.add("is-focus");
  if (hexLuminance(c.hex) < SWATCH_LIGHT_DARK_SPLIT) btn.classList.add("is-dark");

  const fill = document.createElement("span");
  fill.className = "swatch-fill";
  fill.style.background = c.hex;

  if (c.selected) {
    const check = document.createElement("span");
    check.className = "swatch-check";
    check.textContent = "✓";
    btn.append(fill, check);
  } else {
    btn.append(fill);
  }

  const rem = document.createElement("button");
  rem.type = "button";
  rem.className = "swatch-remove";
  rem.setAttribute("aria-label", `Remove ${c.name} from list`);
  rem.title = "Remove from list";
  rem.textContent = "×";
  rem.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    removeColorById(c.id);
  });
  btn.appendChild(rem);

  btn.addEventListener("click", () => {
    c.selected = !c.selected;
    state.focusColorId = c.id;
    renderColorSwatches();
    updateColorNameLabel();
    redrawPreview();
    persistExportColors();
  });

  return btn;
}

function renderColorSwatches() {
  if (!els.colorSwatchRow) return;
  els.colorSwatchRow.innerHTML = "";
  const appendSwatches = (parent, list) => {
    for (const c of list) parent.appendChild(createColorSwatchButton(c));
  };

  if (state.groupSwatchesByLuma) {
    const light = state.colors.filter((c) => hexLuminance(c.hex) >= SWATCH_LIGHT_DARK_SPLIT);
    const dark = state.colors.filter((c) => hexLuminance(c.hex) < SWATCH_LIGHT_DARK_SPLIT);
    if (light.length) {
      const wrap = document.createElement("div");
      wrap.className = "swatch-group";
      const lab = document.createElement("span");
      lab.className = "swatch-group-label";
      lab.textContent = "Light";
      const row = document.createElement("div");
      row.className = "swatch-group-row";
      appendSwatches(row, light);
      wrap.append(lab, row);
      els.colorSwatchRow.appendChild(wrap);
    }
    if (dark.length) {
      const wrap = document.createElement("div");
      wrap.className = "swatch-group";
      const lab = document.createElement("span");
      lab.className = "swatch-group-label";
      lab.textContent = "Dark";
      const row = document.createElement("div");
      row.className = "swatch-group-row";
      appendSwatches(row, dark);
      wrap.append(lab, row);
      els.colorSwatchRow.appendChild(wrap);
    }
    return;
  }

  const row = document.createElement("div");
  row.className = "swatch-group-row";
  appendSwatches(row, state.colors);
  els.colorSwatchRow.appendChild(row);
}

function sanitizeFilePart(s) {
  return s.replace(/[^\w\-]+/g, "-").replace(/^-|-$/g, "") || "color";
}

/** Export folder (first segment) + file name; flattens legacy root/mid/file paths. */
function exportPathRootAndFile(posixPath) {
  const p = String(posixPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (p.length === 0) {
    return { root: DEFAULT_EXPORT_ROOT, file: `export.${EXPORT_MOCKUP_EXT}` };
  }
  if (p.length === 1) return { root: DEFAULT_EXPORT_ROOT, file: p[0] };
  return { root: p[0], file: p[p.length - 1] };
}

/** Folder / download-safe base name from user text (article, SKU, codes). */
function sanitizeExportRootName(s) {
  if (!s || typeof s !== "string") return "";
  let t = s
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/\s+/g, "-");
  t = t.replace(/\.{2,}/g, ".").replace(/^\.+/, "").replace(/\.+$/, "");
  if (t.length > 96) t = t.slice(0, 96);
  return t.replace(/^-+|-+$/g, "") || "";
}

function resolveExportRootFromRaw(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_EXPORT_ROOT;
  const safe = sanitizeExportRootName(trimmed);
  return safe || DEFAULT_EXPORT_ROOT;
}

function resolveExportRootName() {
  return resolveExportRootFromRaw(els.exportRootName?.value ?? "");
}

/** Title + SKU must be set before generating or downloading exports. */
function validateRequiredExportTitleAndSku() {
  const titleRaw = (els.exportRootName?.value ?? "").trim();
  if (!titleRaw) {
    setStatus("Title is required — enter the export folder name.", "error");
    return false;
  }
  const titleSafe = sanitizeExportRootName(titleRaw);
  if (!titleSafe) {
    setStatus(
      "Title is not valid. Use letters, numbers, spaces, or dashes (no path characters).",
      "error"
    );
    return false;
  }
  const skuRaw = (els.exportSku?.value ?? "").trim();
  if (!skuRaw) {
    setStatus("SKU is required.", "error");
    return false;
  }
  const skuSan = sanitizeFilePart(skuRaw);
  if (!skuSan || skuSan === "color") {
    setStatus("SKU must contain at least one letter or number.", "error");
    return false;
  }
  return true;
}

/** Apply a new export root from inline editor or external raw string; updates paths, main field, storage. */
function applyExportFolderRenameFromRaw(raw) {
  const newRoot = resolveExportRootFromRaw(raw);
  const oldRoot = state.exportFolderName;
  if (newRoot !== oldRoot && state.generated.length) {
    for (const g of state.generated) {
      const { file } = exportPathRootAndFile(g.path);
      g.path = `${newRoot}/${file}`;
    }
    state.exportFolderName = newRoot;
    setStatus(`Export folder renamed to “${newRoot}”.`, "ok");
  }
  if (els.exportRootName) {
    els.exportRootName.value = newRoot === DEFAULT_EXPORT_ROOT ? "" : newRoot;
  }
  try {
    localStorage.setItem(
      EXPORT_ROOT_NAME_STORAGE_KEY,
      els.exportRootName?.value?.trim() ?? ""
    );
  } catch (_) {
    /* ignore */
  }
}

/** Build final WebP filename from user input (extension optional). */
function buildExportFileNameFromRaw(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let base = trimmed;
  const extLower = `.${EXPORT_MOCKUP_EXT}`;
  if (base.toLowerCase().endsWith(extLower)) {
    base = base.slice(0, -extLower.length).trim();
  }
  base = sanitizeFilePart(base);
  if (!base) return null;
  return `${base}.${EXPORT_MOCKUP_EXT}`;
}

/**
 * @returns {boolean} false if validation failed
 */
function applyGeneratedFileRenameAt(index, raw) {
  const newFile = buildExportFileNameFromRaw(raw);
  if (!newFile) {
    setStatus(
      "Enter a valid file name (letters, numbers, dashes, underscores).",
      "error"
    );
    return false;
  }
  const g = state.generated[index];
  if (!g) return false;
  const oldFile = g.path.split("/").pop();
  if (newFile === oldFile) return true;
  const dup = state.generated.some(
    (h, i) => i !== index && h.path.split("/").pop() === newFile
  );
  if (dup) {
    setStatus(`Another file is already named “${newFile}”.`, "error");
    return false;
  }
  const { root } = exportPathRootAndFile(g.path);
  g.path = `${root}/${newFile}`;
  setStatus(`File renamed to “${newFile}”.`, "ok");
  return true;
}

/** If the form export name differs from paths, retarget all paths to the form root (ZIP / field stay aligned). */
function syncGeneratedPathsRootWithForm() {
  if (!state.generated.length) return false;
  const formBase = resolveExportRootName();
  const pathBase = state.generated[0].path.split("/")[0];
  if (formBase === pathBase) return false;
  for (const g of state.generated) {
    const { file } = exportPathRootAndFile(g.path);
    g.path = `${formBase}/${file}`;
  }
  state.exportFolderName = formBase;
  return true;
}

/** Safe segment for a flat Downloads filename (no path separators). */
function sanitizeDownloadFileNameSegment(s) {
  if (!s || typeof s !== "string") return "export";
  let t = s
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .replace(/\s+/g, "-");
  t = t.replace(/^\.+|\.+$/g, "");
  if (t.length > 80) t = t.slice(0, 80);
  return t.replace(/^-+|-+$/g, "") || "export";
}

/**
 * Single-file save name so folder + file from the tree appear in Downloads
 * (slashes are not allowed in the `download` attribute on most browsers).
 */
function exportSingleFileDownloadNameFromPath(posixPath) {
  const parts = posixPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return `export.${EXPORT_MOCKUP_EXT}`;
  if (parts.length === 1) return parts[0];
  const file = parts[parts.length - 1];
  const segs = parts.slice(0, -1).map(sanitizeDownloadFileNameSegment);
  const joined = [...segs, file].join("-");
  return joined.replace(/[/\\:*?"<>|]+/g, "-").slice(0, 200);
}

function normalizeColorMatchKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function stripBom(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .trim();
}

/** Quoted fields and newlines inside quotes (Shopify product CSV). */
function parseCsvToRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") {
    rows.push(row);
  }
  return rows;
}

function csvRowsToObjects(rows) {
  if (!rows.length) {
    return { headers: [], records: [] };
  }
  const headerRow = rows[0].map((h) => stripBom(h));
  const width = headerRow.length;
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const rr = rows[r];
    const obj = {};
    for (let j = 0; j < width; j++) {
      const key = headerRow[j] || `col_${j}`;
      obj[key] = rr[j] != null ? rr[j] : "";
    }
    records.push(obj);
  }
  return { headers: headerRow, records };
}

function collectShopifyProductHandles(records) {
  const map = new Map();
  for (const rec of records) {
    const h = stripBom(rec.Handle || "");
    if (!h) continue;
    if (!map.has(h)) {
      const title = stripBom(rec.Title || "") || h;
      map.set(h, title);
    }
  }
  return map;
}

function buildShopifyNamingForHandle(handle, records) {
  const rows = records.filter((r) => stripBom(r.Handle || "") === handle);
  if (!rows.length) return null;
  const first = rows[0];
  const typeVal = stripBom(first.Type || "");
  const subfolder = typeVal ? sanitizeExportRootName(typeVal) : null;
  const colorToBaseName = {};
  for (const r of rows) {
    const color = stripBom(r["Option1 Value"] || "");
    const sku = stripBom(r["Variant SKU"] || "");
    if (!color || !sku) continue;
    const key = normalizeColorMatchKey(color);
    if (key && !colorToBaseName[key]) {
      colorToBaseName[key] = sku;
    }
  }
  return {
    handle,
    subfolder,
    colorToBaseName,
    title: stripBom(first.Title || ""),
    firstVariantSku: stripBom(first["Variant SKU"] || ""),
  };
}

/**
 * Middle file segment: Shopify Variant SKU for this swatch when CSV naming maps the color;
 * otherwise the optional SKU field. Empty string if neither applies.
 * @param {string} colName swatch / color label from the palette
 * @param {{ colorToBaseName?: Record<string, string> } | null | undefined} naming
 */
function resolveExportSkuFilePart(colName, naming) {
  if (naming?.colorToBaseName) {
    const fromCsv = naming.colorToBaseName[normalizeColorMatchKey(colName)];
    if (fromCsv) {
      return sanitizeFilePart(stripBom(fromCsv));
    }
  }
  const raw = els.exportSku?.value?.trim() ?? "";
  if (!raw) return "";
  return sanitizeFilePart(raw);
}

/**
 * WebP base name (no extension): "{title}-{sku?}-{color}" (e.g. this-is-the-stripped-p0001-red).
 * Title comes from the export folder / Title field; SKU from CSV variant when mapped else the SKU field.
 * @param {string} colName swatch / color label from the palette
 * @param {{ colorToBaseName?: Record<string, string> } | null | undefined} naming
 */
function exportFileBaseForColor(colName, naming) {
  const root = resolveExportRootName();
  const titlePart = sanitizeFilePart(root);
  const safeTitle = titlePart || sanitizeFilePart(DEFAULT_EXPORT_ROOT) || "export";
  const skuPart = resolveExportSkuFilePart(colName, naming);
  const formSkuSan = sanitizeFilePart((els.exportSku?.value ?? "").trim());
  const middle = skuPart || formSkuSan;
  const colorPart = sanitizeFilePart(colName);
  const parts = [safeTitle];
  if (middle) parts.push(middle);
  parts.push(colorPart);
  return parts.join("-");
}

function syncGeneratedPathsWithShopifyNaming() {
  const naming = state.shopifyCsvNaming;
  if (!state.generated.length) return;
  const root = resolveExportRootName();
  state.exportFolderName = root;
  for (const g of state.generated) {
    const base = exportFileBaseForColor(g.name, naming);
    const file = `${base}.${EXPORT_MOCKUP_EXT}`;
    g.path = `${root}/${file}`;
  }
}

function resetGeneratedPathsToDefaultColorNames() {
  if (!state.generated.length) return;
  const root = resolveExportRootName();
  state.exportFolderName = root;
  for (const g of state.generated) {
    const fileBase = exportFileBaseForColor(g.name, null);
    const file = `${fileBase}.${EXPORT_MOCKUP_EXT}`;
    g.path = `${root}/${file}`;
  }
}

function updateShopifyCsvPreview() {
  if (!els.shopifyCsvPreview || !state.shopifyCsvParsed) return;
  const handle = stripBom(els.shopifyCsvProduct?.value || "");
  if (!handle) {
    els.shopifyCsvPreview.textContent = "";
    return;
  }
  const built = buildShopifyNamingForHandle(handle, state.shopifyCsvParsed.records);
  if (!built) {
    els.shopifyCsvPreview.textContent = "";
    return;
  }
  const n = Object.keys(built.colorToBaseName).length;
  els.shopifyCsvPreview.textContent = `Preview: folder “${built.handle}/” — ${n} color→SKU pair(s). Swatch names (e.g. Navy) match CSV Option1 Value when possible.`;
}

function applySelectedShopifyCsvNaming() {
  if (!state.shopifyCsvParsed || !els.shopifyCsvProduct?.value) {
    setStatus("Choose a product from the CSV first.", "error");
    return;
  }
  const handle = stripBom(els.shopifyCsvProduct.value);
  const built = buildShopifyNamingForHandle(handle, state.shopifyCsvParsed.records);
  if (!built) {
    setStatus("No rows for that product.", "error");
    return;
  }
  state.shopifyCsvNaming = {
    subfolder: built.subfolder,
    colorToBaseName: built.colorToBaseName,
  };
  if (els.exportRootName) {
    els.exportRootName.value = built.handle;
  }
  if (els.exportSku) {
    els.exportSku.value = built.firstVariantSku || "";
  }
  try {
    localStorage.setItem(
      EXPORT_ROOT_NAME_STORAGE_KEY,
      els.exportRootName?.value?.trim() ?? ""
    );
    localStorage.setItem(
      EXPORT_SKU_STORAGE_KEY,
      els.exportSku?.value?.trim() ?? ""
    );
  } catch (_) {
    /* ignore */
  }
  if (state.generated.length) {
    syncGeneratedPathsWithShopifyNaming();
    renderFolderTree();
  }
  const shortTitle =
    built.title.length > 48 ? `${built.title.slice(0, 45)}…` : built.title || built.handle;
  setStatus(
    `Names from CSV: export folder “${built.handle}”; WebP names use Variant SKU per color when swatches match Option1 Value. ${shortTitle}`,
    "ok"
  );
}

function clearShopifyCsvNaming() {
  state.shopifyCsvNaming = null;
  state.shopifyCsvParsed = null;
  if (els.shopifyCsvFile) els.shopifyCsvFile.value = "";
  if (els.shopifyCsvControls) els.shopifyCsvControls.hidden = true;
  if (els.shopifyCsvProduct) els.shopifyCsvProduct.innerHTML = "";
  if (els.shopifyCsvPreview) els.shopifyCsvPreview.textContent = "";
  if (state.generated.length) {
    resetGeneratedPathsToDefaultColorNames();
    renderFolderTree();
  }
  setStatus("CSV naming cleared.", "ok");
}

function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality
    );
  });
}

async function generateAll() {
  if (!JSZip) {
    setStatus("JSZip failed to load. Check network or CDN.", "error");
    return;
  }
  if (!authHasActiveSubscription()) {
    setStatus("An active subscription is required to generate mockups.", "error");
    return;
  }
  if (!state.baseImg) {
    setStatus("Load a base garment image first.", "error");
    return;
  }
  if (
    !state.garmentMaskCanvas ||
    state.garmentMaskCanvas.width !== state.baseNaturalW ||
    state.garmentMaskCanvas.height !== state.baseNaturalH
  ) {
    rebuildGarmentMask();
  }
  const selected = state.colors.filter((c) => c.selected);
  if (!selected.length) {
    setStatus("Select at least one color.", "error");
    return;
  }
  if (!validateRequiredExportTitleAndSku()) {
    return;
  }

  const n = selected.length;
  setAppLoading(true, {
    overlay: true,
    label: n > 1 ? `Generating 1 / ${n}…` : "Generating mockup…",
  });
  if (els.generateBtn) els.generateBtn.disabled = true;
  if (els.downloadZipBtn) els.downloadZipBtn.disabled = true;
  state.generated = [];
  const w = state.baseNaturalW;
  const h = state.baseNaturalH;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;

  const naming = state.shopifyCsvNaming;
  state.exportFolderName = resolveExportRootName();

  try {
    let i = 0;
    for (const col of selected) {
      i += 1;
      if (n > 1) {
        setPreviewBusyProgress(`Generating ${i} / ${n}…`);
        setStatus(`Generating ${i} of ${n}: ${col.name}…`, "");
      }
      renderComposite(
        out,
        state.baseImg,
        getEffectiveBackgroundHex(),
        col.hex,
        designImageForGarmentHex(col.hex)
      );
      const blob = await canvasToBlob(out, EXPORT_MOCKUP_MIME, EXPORT_MOCKUP_QUALITY);
      const fileBase = exportFileBaseForColor(col.name, naming);
      const fileName = `${fileBase}.${EXPORT_MOCKUP_EXT}`;
      const path = `${state.exportFolderName}/${fileName}`;
      state.generated.push({ name: col.name, path, blob });
    }
    if (els.downloadZipBtn) els.downloadZipBtn.disabled = false;
    renderFolderTree();
    setStatus(
      `Generated ${state.generated.length} WebP(s) under folder “${state.exportFolderName}/”.`,
      "ok"
    );
    void authRecordActivity("generate", state.generated.length);
    try {
      if (els.exportRootName) {
        localStorage.setItem(
          EXPORT_ROOT_NAME_STORAGE_KEY,
          els.exportRootName.value.trim()
        );
      }
      if (els.exportSku) {
        localStorage.setItem(EXPORT_SKU_STORAGE_KEY, els.exportSku.value.trim());
      }
    } catch (_) {
      /* ignore */
    }
  } finally {
    setAppLoading(false);
    if (els.generateBtn) els.generateBtn.disabled = false;
  }
}

function renderFolderTree() {
  for (const u of state.treeObjectUrls) URL.revokeObjectURL(u);
  state.treeObjectUrls = [];

  if (!state.generated.length) {
    els.folderTree.innerHTML =
      '<p class="empty-state">Nothing here yet — pick colors and click <strong>Generate WebPs</strong>.</p>';
    return;
  }
  const root = state.exportFolderName;
  const headRow = document.createElement("div");
  headRow.className = "folder-root-row";
  const viewWrap = document.createElement("div");
  viewWrap.className = "folder-root-view";
  const head = document.createElement("span");
  head.className = "folder-root";
  head.textContent = `${root}/`;
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "folder-tree-edit";
  editBtn.textContent = "Edit";
  editBtn.setAttribute("aria-label", "Edit export folder name");
  viewWrap.append(head, editBtn);
  headRow.append(viewWrap);
  editBtn.addEventListener("click", () => {
    viewWrap.remove();
    const editor = document.createElement("div");
    editor.className = "folder-root-editor";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "folder-root-rename-input";
    inp.value = root === DEFAULT_EXPORT_ROOT ? "" : root;
    inp.placeholder = DEFAULT_EXPORT_ROOT;
    inp.maxLength = 120;
    inp.setAttribute("aria-label", "Export folder name");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-secondary btn-compact folder-root-save";
    saveBtn.textContent = "Save";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn btn-ghost btn-compact folder-root-cancel";
    cancelBtn.textContent = "Cancel";
    editor.append(inp, saveBtn, cancelBtn);
    headRow.append(editor);
    inp.focus();
    inp.select();
    const finish = (apply) => {
      if (apply) applyExportFolderRenameFromRaw(inp.value);
      renderFolderTree();
    };
    saveBtn.addEventListener("click", () => finish(true));
    cancelBtn.addEventListener("click", () => finish(false));
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
  });

  const list = document.createElement("div");
  list.style.paddingLeft = "1.25rem";
  state.generated.forEach((g, index) => {
    const parts = g.path.split("/");
    const file = parts[parts.length - 1];
    const row = document.createElement("div");
    row.className = "folder-entry";
    const viewWrap = document.createElement("div");
    viewWrap.className = "folder-entry-view";
    const a = document.createElement("a");
    const href = URL.createObjectURL(g.blob);
    state.treeObjectUrls.push(href);
    a.href = href;
    a.className = "folder-entry-filename";
    a.download = exportSingleFileDownloadNameFromPath(g.path);
    a.textContent = file;
    a.addEventListener("click", (ev) => {
      if (!authHasActiveSubscription()) {
        ev.preventDefault();
        setStatus("An active subscription is required to download exports.", "error");
        return;
      }
      void authRecordActivity("download", 1);
    });
    const fileEditBtn = document.createElement("button");
    fileEditBtn.type = "button";
    fileEditBtn.className = "folder-tree-edit";
    fileEditBtn.textContent = "Edit";
    fileEditBtn.setAttribute("aria-label", `Edit file name ${file}`);
    const one = document.createElement("span");
    one.className = "dl-one";
    one.textContent = "Download";
    one.addEventListener("click", () => {
      if (!authHasActiveSubscription()) {
        setStatus("An active subscription is required to download exports.", "error");
        return;
      }
      const link = document.createElement("a");
      const h = URL.createObjectURL(g.blob);
      link.href = h;
      link.download = exportSingleFileDownloadNameFromPath(g.path);
      link.click();
      setTimeout(() => URL.revokeObjectURL(h), 4000);
      void authRecordActivity("download", 1);
    });
    viewWrap.append(a, fileEditBtn);
    row.append(viewWrap, one);
    fileEditBtn.addEventListener("click", () => {
      viewWrap.remove();
      const editor = document.createElement("div");
      editor.className = "folder-root-editor folder-entry-editor";
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "folder-root-rename-input";
      inp.value = file;
      inp.placeholder = file;
      inp.maxLength = 160;
      inp.setAttribute("aria-label", "File name");
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "btn btn-secondary btn-compact folder-root-save";
      saveBtn.textContent = "Save";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-ghost btn-compact folder-root-cancel";
      cancelBtn.textContent = "Cancel";
      editor.append(inp, saveBtn, cancelBtn);
      row.insertBefore(editor, one);
      inp.focus();
      inp.select();
      const finish = (apply) => {
        if (apply && !applyGeneratedFileRenameAt(index, inp.value)) return;
        renderFolderTree();
      };
      saveBtn.addEventListener("click", () => finish(true));
      cancelBtn.addEventListener("click", () => finish(false));
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      });
    });
    list.appendChild(row);
  });
  els.folderTree.innerHTML = "";
  els.folderTree.append(headRow, list);
}

async function downloadZip() {
  if (!JSZip || !state.generated.length) return;
  if (!authHasActiveSubscription()) {
    setStatus("An active subscription is required to download exports.", "error");
    return;
  }
  if (!validateRequiredExportTitleAndSku()) {
    return;
  }
  setAppLoading(true, { label: "Building ZIP…" });
  if (els.downloadZipBtn) els.downloadZipBtn.disabled = true;
  try {
    const retargeted = syncGeneratedPathsRootWithForm();
    if (retargeted) renderFolderTree();
    const zip = new JSZip();
    for (const g of state.generated) {
      const { file } = exportPathRootAndFile(g.path);
      zip.file(file, g.blob);
    }
    const zipFileBase =
      state.generated[0].path.split("/")[0] || DEFAULT_EXPORT_ROOT;
    state.exportFolderName = zipFileBase;
    if (els.exportRootName) {
      els.exportRootName.value =
        zipFileBase === DEFAULT_EXPORT_ROOT ? "" : zipFileBase;
    }
    try {
      if (els.exportRootName) {
        localStorage.setItem(
          EXPORT_ROOT_NAME_STORAGE_KEY,
          els.exportRootName.value.trim()
        );
      }
      if (els.exportSku) {
        localStorage.setItem(EXPORT_SKU_STORAGE_KEY, els.exportSku.value.trim());
      }
    } catch (_) {
      /* ignore */
    }
    setPreviewBusyProgress("Compressing…");
    const blob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${sanitizeDownloadFileNameSegment(zipFileBase)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus("ZIP download started.", "ok");
    void authRecordActivity("download", Math.max(1, state.generated.length));
  } finally {
    setAppLoading(false);
    if (els.downloadZipBtn) els.downloadZipBtn.disabled = false;
  }
}

function canvasPointerToNorm(clientX, clientY) {
  const rect = els.previewCanvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const nx = x / rect.width;
  const ny = y / rect.height;
  return {
    nx: Math.min(1, Math.max(0, nx)),
    ny: Math.min(1, Math.max(0, ny)),
  };
}

function clearGarmentMaskAndRefineUi() {
  clearBundledDefaultMaskCache();
  state.garmentMaskCanvas = null;
  state.maskAutoCanvas = null;
  state.maskPaintAdd = null;
  state.maskPaintSub = null;
  state.externalMaskActive = false;
  state.maskHighKeyStudio = false;
  state.alphaCutoutGarmentMask = false;
  if (els.rembgMaskFile) els.rembgMaskFile.value = "";
  state.maskBrushMode = "off";
  state.maskEdgeAdjust = 0;
  state.maskExtraFeather = 0;
  if (els.maskBrushMode) els.maskBrushMode.value = "off";
  if (els.maskEdgeAdjust) els.maskEdgeAdjust.value = "0";
  if (els.maskExtraFeather) els.maskExtraFeather.value = "0";
  syncMaskRefineLabels();
}

/** Removes the active garment from the session list, or clears everything if none match. Loads the next thumb if any remain. */
function removeCurrentGarment() {
  setAppLoading(false);
  if (!state.baseImg && state.baseLibrary.length === 0) {
    setStatus("No garment photo to remove.", "");
    return;
  }
  const id = state.activeBaseId;
  if (id) {
    const idx = state.baseLibrary.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const removed = state.baseLibrary.splice(idx, 1)[0];
      revokeBaseLibraryUrl(removed?.url);
    }
  } else {
    for (const e of state.baseLibrary) {
      revokeBaseLibraryUrl(e.url);
    }
    state.baseLibrary.length = 0;
  }
  state.activeBaseId = null;
  state.baseImg = null;
  state.baseNaturalW = 0;
  state.baseNaturalH = 0;
  state.usingDefaultBase = false;
  clearGarmentMaskAndRefineUi();
  if (els.baseFile) els.baseFile.value = "";
  renderBaseGallery();
  if (state.baseLibrary.length > 0) {
    const next = state.baseLibrary[0];
    state.activeBaseId = next.id;
    renderBaseGallery();
    activateBaseLibraryEntry(next.id);
    setStatus("Removed photo. Showing the next one in your list.", "ok");
    return;
  }
  bootstrapDefaultGarmentPhotos();
  updateMaskPaintOverlayInteractivity();
  setStatus("Restored the three sample shirt photos — upload your own or pick another thumbnail.", "ok");
}

function syncDesignUi() {
  const hasL = isLoadedDesign(state.designLightImg);
  const hasD = isLoadedDesign(state.designDarkImg);
  const any = hasL || hasD;

  if (els.removeDesignLightBtn) {
    els.removeDesignLightBtn.disabled = !any;
    els.removeDesignLightBtn.setAttribute("aria-disabled", any ? "false" : "true");
  }
  if (els.removeDesignDarkBtn) {
    els.removeDesignDarkBtn.disabled = !hasD;
    els.removeDesignDarkBtn.setAttribute("aria-disabled", hasD ? "false" : "true");
  }

  if (els.designLightMeta) {
    const metaName = state.designLightFileName || state.designDarkFileName;
    if (any && metaName) {
      els.designLightMeta.textContent = `Using: ${metaName}`;
      els.designLightMeta.classList.remove("is-hidden");
    } else {
      els.designLightMeta.textContent = "";
      els.designLightMeta.classList.add("is-hidden");
    }
  }
  if (els.designDarkMeta) {
    if (hasD && state.designDarkFileName) {
      els.designDarkMeta.textContent = `Using: ${state.designDarkFileName}`;
      els.designDarkMeta.classList.remove("is-hidden");
    } else {
      els.designDarkMeta.textContent = "";
      els.designDarkMeta.classList.add("is-hidden");
    }
  }

  if (els.designShowOnPreview) {
    els.designShowOnPreview.checked = state.designOverlayVisible;
  }
  if (els.toggleDesignOverlayBtn) {
    els.toggleDesignOverlayBtn.textContent = state.designOverlayVisible
      ? "Hide design"
      : "Show design";
    els.toggleDesignOverlayBtn.disabled = !any;
  }
  if (els.removeAllDesignsBtn) {
    els.removeAllDesignsBtn.disabled = !any;
  }
  if (els.previewDesignActions) {
    els.previewDesignActions.hidden = !any;
  }
}

function removeDesignSlot(slot, options = {}) {
  const silentIfEmpty = options.silentIfEmpty === true;
  const isLight = slot === "light";
  const has = isLight
    ? isLoadedDesign(state.designLightImg)
    : isLoadedDesign(state.designDarkImg);
  if (!has) {
    if (!silentIfEmpty) {
      setStatus(isLight ? "No artwork to remove." : "No dark design to remove.", "");
    }
    syncDesignUi();
    return;
  }
  if (isLight) {
    state.designLightImg = null;
    state.designLightFileName = "";
    if (els.designLightFile) els.designLightFile.value = "";
    state.designDarkImg = null;
    state.designDarkFileName = "";
    if (els.designDarkFile) els.designDarkFile.value = "";
  } else {
    state.designDarkImg = null;
    state.designDarkFileName = "";
    if (els.designDarkFile) els.designDarkFile.value = "";
  }
  syncDesignUi();
  redrawPreview();
  if (!silentIfEmpty) {
    setStatus(isLight ? "Artwork removed." : "Dark design removed.", "ok");
  }
}

function removeAllDesigns(options = {}) {
  const silent = options.silent === true;
  const had = anyDesignLoaded();
  state.designLightImg = null;
  state.designDarkImg = null;
  state.designLightFileName = "";
  state.designDarkFileName = "";
  if (els.designLightFile) els.designLightFile.value = "";
  if (els.designDarkFile) els.designDarkFile.value = "";
  syncDesignUi();
  redrawPreview();
  if (!silent && had) setStatus("All artwork removed.", "ok");
}

function bindDesignFileInput(inputEl, slot) {
  if (!inputEl) return;
  inputEl.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    const isLight = slot === "light";
    if (!f) {
      if (isLight) removeAllDesigns({ silent: true });
      else removeDesignSlot(slot, { silentIfEmpty: true });
      return;
    }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      if (isLight) {
        state.designLightImg = img;
        state.designLightFileName = f.name || "Artwork";
        state.designDarkImg = null;
        state.designDarkFileName = "";
        if (els.designDarkFile) els.designDarkFile.value = "";
      } else {
        state.designDarkImg = img;
        state.designDarkFileName = f.name || "Artwork";
      }
      URL.revokeObjectURL(url);
      mirrorWorkFileToServer(f, "design");
      syncDesignUi();
      redrawPreview();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (isLight) {
        state.designLightImg = null;
        state.designLightFileName = "";
        if (els.designLightFile) els.designLightFile.value = "";
      } else {
        state.designDarkImg = null;
        state.designDarkFileName = "";
        if (els.designDarkFile) els.designDarkFile.value = "";
      }
      syncDesignUi();
      redrawPreview();
      setStatus("Could not load that design image.", "error");
    };
    img.src = url;
  });
}

if (els.removeBaseBtn) {
  els.removeBaseBtn.addEventListener("click", () => removeCurrentGarment());
}
if (els.removeDesignLightBtn) {
  els.removeDesignLightBtn.addEventListener("click", () => removeAllDesigns());
}
if (els.removeDesignDarkBtn) {
  els.removeDesignDarkBtn.addEventListener("click", () => removeDesignSlot("dark"));
}
if (els.designShowOnPreview) {
  els.designShowOnPreview.addEventListener("change", () => {
    state.designOverlayVisible = !!els.designShowOnPreview.checked;
    syncDesignUi();
    redrawPreview();
  });
}
if (els.toggleDesignOverlayBtn) {
  els.toggleDesignOverlayBtn.addEventListener("click", () => {
    if (!anyDesignLoaded()) return;
    state.designOverlayVisible = !state.designOverlayVisible;
    syncDesignUi();
    redrawPreview();
  });
}
if (els.removeAllDesignsBtn) {
  els.removeAllDesignsBtn.addEventListener("click", () => removeAllDesigns());
}

bindDesignFileInput(els.designLightFile, "light");
bindDesignFileInput(els.designDarkFile, "dark");

els.baseFile.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) {
    clearGarmentMaskAndRefineUi();
    state.baseImg = null;
    state.baseNaturalW = 0;
    state.baseNaturalH = 0;
    state.usingDefaultBase = false;
    updateMaskPaintOverlayInteractivity();
    bootstrapDefaultGarmentPhotos();
    setStatus("Restored sample shirts — upload a garment photo when you’re ready.", "");
    return;
  }
  addBaseToLibrary(f);
  mirrorWorkFileToServer(f, "garment");
  const entry = state.baseLibrary.find((x) => x.id === state.activeBaseId);
  if (!entry) return;
  setStatus("Loading your photo — masking and colors run next…", "");
  setAppLoading(true, { label: "Loading photo…" });
  const img = new Image();
  img.onload = () => {
    runBaseImagePipeline(entry.file, img);
  };
  img.onerror = () => {
    setAppLoading(false);
    setStatus("Invalid image file.", "error");
  };
  img.src = entry.url;
});

if (els.sceneBg) {
  els.sceneBg.addEventListener("input", () => redrawPreview());
}

document.querySelectorAll("[data-scene-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const n = normalizeHex(btn.getAttribute("data-scene-preset") || "");
    if (!n || !els.sceneBg) return;
    els.sceneBg.value = n;
    redrawPreview();
  });
});

if (els.groupExportSwatches) {
  els.groupExportSwatches.addEventListener("change", () => {
    state.groupSwatchesByLuma = !!els.groupExportSwatches.checked;
    renderColorSwatches();
    persistExportColors();
  });
}

if (els.studioPhotorealFinish) {
  els.studioPhotorealFinish.addEventListener("change", () => {
    state.studioPhotorealFinish = !!els.studioPhotorealFinish.checked;
    redrawPreview();
  });
}
if (els.contactShadowEnable) {
  els.contactShadowEnable.addEventListener("change", () => {
    state.contactShadowEnabled = !!els.contactShadowEnable.checked;
    redrawPreview();
  });
}
if (els.pureWhiteProductMode) {
  els.pureWhiteProductMode.addEventListener("change", () => {
    state.pureWhiteProductMode = !!els.pureWhiteProductMode.checked;
    state.recolorDecomp = null;
    syncBackdropInactiveHint();
    redrawPreview();
  });
}
if (els.contactShadowOpacity) {
  els.contactShadowOpacity.addEventListener("input", () => {
    state.contactShadowOpacity =
      Number(els.contactShadowOpacity.value) / 100;
    if (els.contactShadowOpacityVal) {
      els.contactShadowOpacityVal.textContent = `${Math.round(
        state.contactShadowOpacity * 100
      )}%`;
    }
    redrawPreview();
  });
}

if (els.maskTolerance) {
  els.maskTolerance.addEventListener("input", () => {
    state.maskTolerance = Number(els.maskTolerance.value);
    if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
    if (state.baseImg && !state.externalMaskActive) {
      rebuildGarmentMask();
      redrawPreview();
    }
  });
}

if (els.rebuildMaskBtn) {
  els.rebuildMaskBtn.addEventListener("click", () => {
    if (!state.baseImg) {
      setStatus("Upload a garment photo first.", "error");
      return;
    }
    setAppLoading(true, { label: "Refreshing cutout…" });
    requestAnimationFrame(() => {
      try {
        if (els.rembgMaskFile) els.rembgMaskFile.value = "";
        if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
        rebuildGarmentMask();
        redrawPreview();
        setStatus("Mask refreshed from your photo — preview colors updated.", "ok");
      } finally {
        setAppLoading(false);
      }
    });
  });
}

if (els.rembgMaskFile) {
  els.rembgMaskFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setAppLoading(true, {
      overlay: true,
      label: "Applying cutout mask…",
    });
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        applyRembgMaskFromImage(img);
        clearBundledDefaultMaskCache();
      } finally {
        setAppLoading(false);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setAppLoading(false);
      setStatus("Could not read that mask PNG.", "error");
    };
    img.src = url;
  });
}

if (els.clearRembgMaskBtn) {
  els.clearRembgMaskBtn.addEventListener("click", () => {
    if (!state.baseImg) {
      setStatus("Load a garment photo first.", "error");
      return;
    }
    setAppLoading(true, { label: "Rebuilding cutout…" });
    requestAnimationFrame(() => {
      try {
        if (els.rembgMaskFile) els.rembgMaskFile.value = "";
        if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
        rebuildGarmentMask();
        redrawPreview();
        setStatus("Switched back to automatic cutout from your photo.", "ok");
      } finally {
        setAppLoading(false);
      }
    });
  });
}

if (els.texturePreserve) {
  els.texturePreserve.addEventListener("input", () => {
    state.texturePreserve = Number(els.texturePreserve.value) / 100;
    syncTextureDefringeLabels();
    redrawPreview();
  });
}

if (els.defringeStrength) {
  els.defringeStrength.addEventListener("input", () => {
    state.defringeStrength = Number(els.defringeStrength.value) / 100;
    syncTextureDefringeLabels();
    redrawPreview();
  });
}

if (els.multiplyTintRecolor) {
  els.multiplyTintRecolor.addEventListener("change", () => {
    state.multiplyTintRecolor = !!els.multiplyTintRecolor.checked;
    redrawPreview();
  });
}

if (els.designFabricBlend) {
  els.designFabricBlend.addEventListener("input", () => {
    state.designFabricBlend = Number(els.designFabricBlend.value) / 100;
    syncTextureDefringeLabels();
    redrawPreview();
  });
}

document.querySelectorAll('input[name="previewMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (radio.checked) {
      state.previewMode = radio.value;
      redrawPreview();
    }
  });
});

if (els.designScale && els.scaleVal) {
  els.designScale.addEventListener("input", () => {
    state.designScalePct = Number(els.designScale.value);
    els.scaleVal.textContent = `${state.designScalePct}%`;
    redrawPreview();
  });
}

if (els.designRot && els.rotVal) {
  els.designRot.addEventListener("input", () => {
    state.designRotDeg = Number(els.designRot.value);
    els.rotVal.textContent = `${state.designRotDeg}°`;
    redrawPreview();
  });
}

if (els.customColor) {
  els.customColor.addEventListener("input", () => syncHexFieldFromPicker());
}

if (els.customColorHex) {
  els.customColorHex.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyHexFromText();
    }
  });
  els.customColorHex.addEventListener("blur", () => applyHexFromText());
}

if (els.addCustomColor) {
  els.addCustomColor.addEventListener("click", () => {
    addCustomExportColorToList();
  });
}

if (els.customColorName) {
  els.customColorName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomExportColorToList();
    }
  });
}

if (els.resetDefaultColors) {
  els.resetDefaultColors.addEventListener("click", () => {
    initColorsPresetOnly();
    syncHexFieldFromPicker();
  });
}

if (els.selectAllColors) {
  els.selectAllColors.addEventListener("click", () => {
    for (const c of state.colors) c.selected = true;
    renderColorSwatches();
    updateColorNameLabel();
    redrawPreview();
    persistExportColors();
  });
}

if (els.deselectAllColors) {
  els.deselectAllColors.addEventListener("click", () => {
    for (const c of state.colors) c.selected = false;
    renderColorSwatches();
    updateColorNameLabel();
    redrawPreview();
    persistExportColors();
  });
}

els.generateBtn.addEventListener("click", () => generateAll());
els.downloadZipBtn.addEventListener("click", () => downloadZip());

if (els.shopifyCsvFile) {
  els.shopifyCsvFile.addEventListener("change", async () => {
    const f = els.shopifyCsvFile.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const matrix = parseCsvToRows(text);
      if (!matrix.length) {
        setStatus("That CSV file appears empty.", "error");
        return;
      }
      const { headers, records } = csvRowsToObjects(matrix);
      if (!headers.length) {
        setStatus("Could not read CSV headers.", "error");
        return;
      }
      state.shopifyCsvParsed = { headers, records };
      const handles = collectShopifyProductHandles(records);
      if (els.shopifyCsvProduct) {
        els.shopifyCsvProduct.innerHTML = "";
        for (const [hand, title] of handles) {
          const opt = document.createElement("option");
          opt.value = hand;
          const label = title.length > 72 ? `${title.slice(0, 69)}…` : title;
          opt.textContent = label;
          els.shopifyCsvProduct.appendChild(opt);
        }
      }
      if (els.shopifyCsvControls) {
        els.shopifyCsvControls.hidden = handles.size === 0;
      }
      if (handles.size === 0) {
        setStatus("No products found (need a Handle column with values).", "error");
        return;
      }
      updateShopifyCsvPreview();
      setStatus(
        `Loaded ${records.length} row(s), ${handles.size} product(s). Pick one and click Apply.`,
        "ok"
      );
    } catch (_) {
      setStatus("Could not read that CSV file.", "error");
    }
  });
}
if (els.shopifyCsvProduct) {
  els.shopifyCsvProduct.addEventListener("change", () => updateShopifyCsvPreview());
}
if (els.shopifyCsvApply) {
  els.shopifyCsvApply.addEventListener("click", () => applySelectedShopifyCsvNaming());
}
if (els.shopifyCsvClear) {
  els.shopifyCsvClear.addEventListener("click", () => clearShopifyCsvNaming());
}

if (els.maskEdgeAdjust) {
  els.maskEdgeAdjust.addEventListener("input", () => {
    state.maskEdgeAdjust = Number(els.maskEdgeAdjust.value);
    syncMaskRefineLabels();
    syncRefinedGarmentMask();
    redrawPreview();
  });
}
if (els.maskExtraFeather) {
  els.maskExtraFeather.addEventListener("input", () => {
    state.maskExtraFeather = Number(els.maskExtraFeather.value);
    syncMaskRefineLabels();
    syncRefinedGarmentMask();
    redrawPreview();
  });
}
if (els.maskBrushMode) {
  els.maskBrushMode.addEventListener("change", () => {
    state.maskBrushMode = els.maskBrushMode.value;
    updateMaskPaintOverlayInteractivity();
    syncPreviewOverlaySize();
    updatePreviewToolbarHint();
  });
}
if (els.maskBrushSize) {
  els.maskBrushSize.addEventListener("input", () => {
    state.maskBrushSizeNat = Number(els.maskBrushSize.value);
    syncMaskRefineLabels();
  });
}
els.clearMaskPaintBtn?.addEventListener("click", () => {
  if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
  clearMaskPaintLayers();
  syncRefinedGarmentMask();
  redrawPreview();
  setStatus("Brush strokes cleared.", "ok");
});
els.resetMaskRefineBtn?.addEventListener("click", () => {
  if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
  state.maskEdgeAdjust = 0;
  state.maskExtraFeather = 0;
  if (els.maskEdgeAdjust) els.maskEdgeAdjust.value = "0";
  if (els.maskExtraFeather) els.maskExtraFeather.value = "0";
  clearMaskPaintLayers();
  syncMaskRefineLabels();
  syncRefinedGarmentMask();
  redrawPreview();
  setStatus("Mask refinements reset.", "ok");
});

if (els.maskPaintOverlay) {
  els.maskPaintOverlay.addEventListener("pointerdown", (e) => {
    if (state.maskBrushMode === "off" || !state.baseImg) return;
    e.preventDefault();
    state.maskPainting = true;
    els.maskPaintOverlay.setPointerCapture(e.pointerId);
    const { x: px, y: py } = clientToPreviewCanvasPx(e.clientX, e.clientY);
    const { x: nx, y: ny } = previewCanvasPxToNatural(px, py);
    stampMaskBrush(nx, ny, state.maskBrushMode);
    syncRefinedGarmentMask();
    redrawPreview();
    drawMaskBrushCursorOverlay(e.clientX, e.clientY);
  });
  els.maskPaintOverlay.addEventListener("pointermove", (e) => {
    if (state.maskBrushMode === "off" || !state.baseImg) return;
    if (state.maskPainting) {
      e.preventDefault();
      const { x: px, y: py } = clientToPreviewCanvasPx(e.clientX, e.clientY);
      const { x: nx, y: ny } = previewCanvasPxToNatural(px, py);
      stampMaskBrush(nx, ny, state.maskBrushMode);
      syncRefinedGarmentMask();
      redrawPreview();
    }
    drawMaskBrushCursorOverlay(e.clientX, e.clientY);
  });
  els.maskPaintOverlay.addEventListener("pointerup", (e) => {
    if (!state.maskPainting) return;
    state.maskPainting = false;
    try {
      els.maskPaintOverlay.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    syncRefinedGarmentMask();
    redrawPreview();
    if (state.activeBaseId) invalidateBundledDefaultMaskCacheForId(state.activeBaseId);
  });
  els.maskPaintOverlay.addEventListener("pointercancel", () => {
    state.maskPainting = false;
  });
}

els.previewCanvas.addEventListener("pointerdown", (e) => {
  if (state.maskBrushMode !== "off") return;
  if (!activePreviewDesign()) return;
  state.dragging = true;
  state.dragLast = canvasPointerToNorm(e.clientX, e.clientY);
  fitCanvasToImage();
  ensureGarmentPreviewCache(els.previewCanvas.width, els.previewCanvas.height);
  els.previewCanvas.setPointerCapture(e.pointerId);
});

els.previewCanvas.addEventListener("pointermove", (e) => {
  if (state.maskBrushMode !== "off") return;
  if (!state.dragging || !activePreviewDesign()) return;
  const { nx, ny } = canvasPointerToNorm(e.clientX, e.clientY);
  const dx = nx - state.dragLast.nx;
  const dy = ny - state.dragLast.ny;
  state.designNx += dx;
  state.designNy += dy;
  state.designNx = Math.min(1, Math.max(0, state.designNx));
  state.designNy = Math.min(1, Math.max(0, state.designNy));
  state.dragLast = { nx, ny };
  schedulePreviewDragRedraw();
});

els.previewCanvas.addEventListener("pointerup", (e) => {
  state.dragging = false;
  try {
    els.previewCanvas.releasePointerCapture(e.pointerId);
  } catch (_) {
    /* ignore */
  }
  if (_previewDragRafId) {
    cancelAnimationFrame(_previewDragRafId);
    _previewDragRafId = 0;
  }
  redrawPreview();
});

els.previewCanvas.addEventListener(
  "wheel",
  (e) => {
    if (state.maskBrushMode !== "off") return;
    if (!els.designScale || !els.scaleVal) return;
    if (!activePreviewDesign()) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -2 : 2;
    state.designScalePct = Math.min(100, Math.max(8, state.designScalePct + delta));
    els.designScale.value = String(state.designScalePct);
    els.scaleVal.textContent = `${state.designScalePct}%`;
    fitCanvasToImage();
    ensureGarmentPreviewCache(els.previewCanvas.width, els.previewCanvas.height);
    schedulePreviewDragRedraw();
    schedulePreviewFullRedrawAfterWheel();
  },
  { passive: false }
);

initExportColorsFromDiskOrDefaults();
if (els.exportRootName) {
  try {
    const saved = localStorage.getItem(EXPORT_ROOT_NAME_STORAGE_KEY);
    if (saved !== null) els.exportRootName.value = saved;
  } catch (_) {
    /* ignore */
  }
}
if (els.exportSku) {
  try {
    const savedSku = localStorage.getItem(EXPORT_SKU_STORAGE_KEY);
    if (savedSku !== null) els.exportSku.value = savedSku;
  } catch (_) {
    /* ignore */
  }
}
syncHexFieldFromPicker();
if (els.maskTolerance) {
  state.maskTolerance = Number(els.maskTolerance.value);
}
if (els.texturePreserve) {
  state.texturePreserve = Number(els.texturePreserve.value) / 100;
}
if (els.defringeStrength) {
  state.defringeStrength = Number(els.defringeStrength.value) / 100;
}
if (els.multiplyTintRecolor) {
  state.multiplyTintRecolor = !!els.multiplyTintRecolor.checked;
}
if (els.designFabricBlend) {
  state.designFabricBlend = Number(els.designFabricBlend.value) / 100;
}
if (els.maskEdgeAdjust) {
  state.maskEdgeAdjust = Number(els.maskEdgeAdjust.value);
}
if (els.maskExtraFeather) {
  state.maskExtraFeather = Number(els.maskExtraFeather.value);
}
if (els.maskBrushSize) {
  state.maskBrushSizeNat = Number(els.maskBrushSize.value);
}
if (els.maskBrushMode) {
  state.maskBrushMode = els.maskBrushMode.value;
}
if (els.studioPhotorealFinish) {
  state.studioPhotorealFinish = !!els.studioPhotorealFinish.checked;
}
if (els.contactShadowEnable) {
  state.contactShadowEnabled = !!els.contactShadowEnable.checked;
}
if (els.pureWhiteProductMode) {
  state.pureWhiteProductMode = !!els.pureWhiteProductMode.checked;
}
syncBackdropInactiveHint();
if (els.contactShadowOpacity) {
  state.contactShadowOpacity =
    Number(els.contactShadowOpacity.value) / 100;
  if (els.contactShadowOpacityVal) {
    els.contactShadowOpacityVal.textContent = `${Math.round(
      state.contactShadowOpacity * 100
    )}%`;
  }
}
syncTextureDefringeLabels();
syncMaskRefineLabels();
updateMaskPaintOverlayInteractivity();
if (els.scaleVal) els.scaleVal.textContent = `${state.designScalePct}%`;
if (els.rotVal) els.rotVal.textContent = `${state.designRotDeg}°`;
{
  const r = document.querySelector(
    `input[name="previewMode"][value="${state.previewMode}"]`
  );
  if (r) r.checked = true;
}

state.baseImg = null;
state.usingDefaultBase = false;
syncDesignUi();
bootstrapDefaultGarmentPhotos();

void authInit();

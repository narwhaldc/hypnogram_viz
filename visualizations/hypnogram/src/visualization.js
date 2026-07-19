import { VisualizationAPI } from '@splunk/dashboard-studio-extension';
import './visualization.css';

/* ------------------------------------------------------------------ *
 * Stepped category-over-time timeline (a "hypnogram").
 * Lanes are configurable via the `lanes` option (ordered top→bottom);
 * defaults to sleep stages. Slot size via `slotMinutes` (default 5).
 * Expected columns: offset_min (number), time_label (HH:MM), stage.
 * The `stage` value must match a lane `label`.
 * ------------------------------------------------------------------ */

const DEFAULT_SLOT_MIN = 5; // minutes represented by each data row
// Fallback palette for auto-derived lanes when no explicit `lanes` option is
// provided. Lanes are the data's distinct `stage` values sorted desc, so for
// HR zones index 0 = Z5 Max ... index 5 = Z0 Recovery. Dashboards SHOULD pass
// an explicit `lanes` option (label-keyed, stable); this is only a graceful
// fallback so the viz always renders something.
const AUTO_PALETTE = [
    '#E8503A', '#E8843A', '#F4A422', '#4263B8', '#00CDAF',
    '#4CAF50', '#009CEB', '#7B56DB', '#A78BFA', '#6B7280',
];

// `lanes` may arrive as an array of {label,color} OR a JSON string of the same
// (Dashboard Studio reliably forwards scalar/string options to custom vizzes,
// but not always arrays — so we accept both).
function parseLanes(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        try {
            const p = JSON.parse(v);
            return Array.isArray(p) ? p : null;
        } catch (e) {
            return null;
        }
    }
    return null;
}

// Distinct non-empty `stage` values present in the raw data (unfiltered).
function distinctStages(data) {
    if (!data) return [];
    const fields = (data.fields || []).map((f) => (f.name ? f.name : f));
    const columns = data.columns || [];
    const iStage = fields.indexOf('stage');
    if (iStage < 0 || !columns[iStage]) return [];
    const set = new Set();
    for (const v of columns[iStage]) if (v != null && v !== '') set.add(String(v));
    return [...set];
}

// Build ordered lanes (top->bottom) + lookup maps. Priority:
//   1) explicit `lanes` option (array or JSON string) — the intended path
//   2) auto-derive from the data's distinct `stage` values (highest on top)
function resolveLanes(options, dataStages) {
    const parsed = parseLanes(options && options.lanes);
    let list;
    if (parsed && parsed.length) {
        list = parsed
            .filter((x) => x && x.label != null)
            .map((x) => ({ label: String(x.label), color: x.color || '#8a93a0' }));
    } else {
        // No explicit lanes — derive from data stages, highest label on top.
        list = [...new Set(dataStages || [])]
            .sort()
            .reverse()
            .map((s, i) => ({ label: s, color: AUTO_PALETTE[i % AUTO_PALETTE.length] }));
    }
    const laneOf = {};
    const colorOf = {};
    list.forEach((s, i) => {
        laneOf[s.label] = i;
        colorOf[s.label] = s.color;
    });
    return { lanes: list, laneOf, colorOf };
}

const THEME = {
    light: { text: '#3c444d', muted: '#6b7683', grid: 'rgba(60,68,77,0.14)', tipBg: '#ffffff', tipText: '#1a1a1a', tipBorder: 'rgba(0,0,0,0.15)' },
    dark: { text: '#c3cbd4', muted: '#8a93a0', grid: 'rgba(195,203,212,0.14)', tipBg: '#23262e', tipText: '#e9edf2', tipBorder: 'rgba(255,255,255,0.14)' },
};

// Keep lane LABEL text color-coded but legible: lane blocks always use the
// true lane color, while a too-dark label (dark theme) or too-light label
// (light theme) is blended toward white/black to meet a luminance floor.
function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(n)) return null;
    const v = parseInt(n, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function legibleLabelColor(color, theme) {
    const rgb = hexToRgb(color);
    if (!rgb) return color;
    let [r, g, b] = rgb;
    const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255; // perceived luminance 0..1
    if (theme === 'light') {
        const floor = 0.5;
        if (L > floor) { const t = Math.min(1, (L - floor) / (1 - floor)); r *= (1 - t); g *= (1 - t); b *= (1 - t); }
    } else {
        const floor = 0.6;
        if (L < floor) { const t = Math.min(1, (floor - L) / floor); r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t; }
    }
    return rgbToHex(r, g, b);
}

const rootElement = document.getElementById('root') || document.body;
const container = document.createElement('div');
container.className = 'viz-container';
rootElement.appendChild(container);

const canvas = document.createElement('canvas');
canvas.className = 'hyp-canvas';
container.appendChild(canvas);

const tooltip = document.createElement('div');
tooltip.className = 'hyp-tooltip';
tooltip.style.display = 'none';
container.appendChild(tooltip);

const message = document.createElement('div');
message.className = 'hyp-message';
message.style.display = 'none';
container.appendChild(message);

// Panel background is provided by the native panel `backgroundColor` option
// (set on the dashboard panel), which composites behind this transparent
// iframe over the dashboard's background SVG. We therefore default to NOT
// painting a fill inside the canvas — set the `backgroundFill` option to a
// color only if you are NOT using the panel's backgroundColor.
const DEFAULT_BG_FILL = 'transparent';
// Opacity of the drawn content (stage blocks + risers) so the background
// also shows through the viz itself (matches the Calorie Trend "Area opacity").
const DEFAULT_CONTENT_OPACITY = 0.85;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

const state = {
    data: null,
    loading: false,
    options: {},
    width: 0,
    height: 0,
    theme: 'dark',
    lanes: [],
    laneOf: {},
    colorOf: {},
    slotMin: DEFAULT_SLOT_MIN,
    segments: [], // { stage, startMin, endMin, startLabel, endLabel, durMin }
    totalMin: 0,
    ticks: [], // { min, label, major }
    hitRects: [], // { x, y, w, h, seg }
    // Brush-to-zoom (client-side visual zoom; no re-query). `view` is the
    // visible window in normalized minutes (null = full range). `geom` caches
    // the plot rect so the mouse handlers can map pixels <-> minutes.
    view: null,
    geom: null,
    resetBtn: null, // { x, y, w, h } of the on-canvas reset button when zoomed
    startDate: '', // date_label of the first/last row — used to date synthesized
    endDate: '',   // axis edge ticks when no on-the-hour tick exists (see below)
    mode: 'view',
    mouseDown: false,
    dragging: false,
    dragStartX: 0,
    dragCurX: 0,
};

/* ---------------------------- data prep ---------------------------- */

function rowsFrom(data) {
    if (!data) return [];
    const fields = (data.fields || []).map((f) => (f.name ? f.name : f));
    const columns = data.columns || [];
    if (!columns.length || !columns[0] || !columns[0].length) return [];
    const idx = (name) => fields.indexOf(name);
    const iOff = idx('offset_min');
    const iLabel = idx('time_label');
    const iStage = idx('stage');
    const iDate = idx('date_label'); // optional — enables the date-aware axis
    const n = columns[0].length;
    const out = [];
    for (let i = 0; i < n; i++) {
        const stage = iStage >= 0 ? columns[iStage][i] : null;
        if (!Object.prototype.hasOwnProperty.call(state.laneOf, stage)) continue;
        out.push({
            offset: iOff >= 0 ? parseInt(columns[iOff][i], 10) : i * state.slotMin,
            label: iLabel >= 0 ? String(columns[iLabel][i]) : '',
            date: iDate >= 0 ? String(columns[iDate][i]) : '',
            stage,
        });
    }
    out.sort((a, b) => a.offset - b.offset);
    return out;
}

// "HH:MM" + minutes -> "HH:MM" (24h, wraps at 24)
function addMinutes(label, add) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(label || '');
    if (!m) return label || '';
    let total = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + add) % (24 * 60);
    if (total < 0) total += 24 * 60;
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}

function buildModel() {
    const rows = rowsFrom(state.data);
    state.segments = [];
    state.ticks = [];
    state.totalMin = 0;
    if (!rows.length) return;

    // Slot size: explicit option, else the smallest positive gap between
    // offsets in the data (auto-detects 5-min sleep vs 15-min HR-zone rows).
    let slot = parseFloat(state.options.slotMinutes);
    if (!(slot > 0)) {
        let minGap = Infinity;
        for (let i = 1; i < rows.length; i++) {
            const g = rows[i].offset - rows[i - 1].offset;
            if (g > 0 && g < minGap) minGap = g;
        }
        slot = minGap === Infinity ? DEFAULT_SLOT_MIN : minGap;
    }
    state.slotMin = slot;

    const first = rows[0].offset;
    // Collapse consecutive equal stages into blocks.
    let seg = null;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (seg && r.stage === seg.stage && r.offset === seg.endMin) {
            seg.endMin = r.offset + state.slotMin;
            seg.lastLabel = r.label;
        } else {
            if (seg) state.segments.push(seg);
            seg = {
                stage: r.stage,
                startMin: r.offset,
                endMin: r.offset + state.slotMin,
                startLabel: r.label,
                lastLabel: r.label,
            };
        }
    }
    if (seg) state.segments.push(seg);

    // Normalize to start at 0 and finalize labels/durations.
    state.segments.forEach((s) => {
        s.durMin = s.endMin - s.startMin;
        s.endLabel = addMinutes(s.startLabel, s.durMin);
        s.startMin -= first;
        s.endMin -= first;
    });
    state.totalMin = state.segments.length ? state.segments[state.segments.length - 1].endMin : 0;
    state.startDate = rows.length ? rows[0].date : '';
    state.endDate = rows.length ? rows[rows.length - 1].date : '';
    state.ticks = buildTicks(rows, first);
}

// Parse "HH:MM" -> {h, m} or null.
function parseHM(label) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(label || '');
    return m ? { h: parseInt(m[1], 10), m: parseInt(m[2], 10) } : null;
}

// Axis ticks. Single-day (<=24h): hourly HH:MM. Multi-day: dates at midnight
// (from date_label) plus HH:MM at a spacing chosen to keep ~<=12 ticks.
function buildTicks(rows, first) {
    const span = state.totalMin;
    const ticks = [];
    if (span <= 0) return ticks;

    if (span <= 1440) {
        for (const r of rows) {
            const t = parseHM(r.label);
            if (t && t.m === 0) ticks.push({ min: r.offset - first, label: r.label, date: r.date, major: false });
        }
        return ticks;
    }

    // Multi-day: pick an hour interval so the axis stays uncluttered.
    const spanH = span / 60;
    let H = 24;
    for (const c of [3, 6, 12, 24]) {
        if (spanH / c <= 12) { H = c; break; }
    }
    for (const r of rows) {
        const t = parseHM(r.label);
        if (!t || t.m !== 0 || t.h % H !== 0) continue;
        const midnight = t.h === 0;
        ticks.push({
            min: r.offset - first,
            label: midnight ? r.date || r.label : r.label,
            major: midnight,
        });
    }
    return ticks;
}

/* ----------------------------- drawing ---------------------------- */

function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, rr);
        return;
    }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function render() {
    const c = THEME[state.theme] || THEME.dark;

    // Resolve lanes + slot size from options (needed before building the model).
    const laneInfo = resolveLanes(state.options, distinctStages(state.data));
    state.lanes = laneInfo.lanes;
    state.laneOf = laneInfo.laneOf;
    state.colorOf = laneInfo.colorOf;

    // State screens
    if (state.loading) return showMessage('Loading…');
    if (!state.segments.length) {
        buildModel();
        if (!state.segments.length) return showMessage('No data');
    }
    message.style.display = 'none';
    canvas.style.display = 'block';

    const w = state.width;
    const h = state.height;
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Translucent panel background — lets the dashboard's arch SVG show through.
    const bgFill = state.options.backgroundFill ?? DEFAULT_BG_FILL;
    if (bgFill && bgFill !== 'transparent' && bgFill !== 'none') {
        ctx.fillStyle = bgFill;
        ctx.fillRect(0, 0, w, h);
    }

    // Dynamic left margin sized to the widest lane label (fits "Z3 Moderate" etc.).
    ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
    let maxLabelW = 0;
    for (const s of state.lanes) maxLabelW = Math.max(maxLabelW, ctx.measureText(s.label).width);
    const padL = Math.min(150, Math.max(44, Math.ceil(maxLabelW) + 20));
    const padR = 16;
    const padT = 14;
    const padB = 30;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);
    const laneH = plotH / state.lanes.length;
    const laneCenter = (i) => padT + (i + 0.5) * laneH;
    const blockH = Math.min(laneH * 0.5, 24);
    const totalMin = state.totalMin || 1;
    // Visible window (client-side zoom). Default = full range.
    const viewStart = state.view ? Math.max(0, state.view.startMin) : 0;
    const viewEnd = state.view ? Math.min(totalMin, state.view.endMin) : totalMin;
    const span = Math.max(1e-6, viewEnd - viewStart);
    const xOf = (min) => padL + ((min - viewStart) / span) * plotW;
    // Cache geometry for the brush/zoom mouse handlers (CSS-px space).
    state.geom = { padL, plotW, padT, plotH, viewStart, viewEnd, span };

    // Lane guides + labels
    ctx.textBaseline = 'middle';
    state.lanes.forEach((s, i) => {
        const cy = laneCenter(i);
        ctx.strokeStyle = c.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(cy) + 0.5);
        ctx.lineTo(padL + plotW, Math.round(cy) + 0.5);
        ctx.stroke();

        ctx.fillStyle = legibleLabelColor(s.color, state.theme);
        ctx.textAlign = 'left';
        ctx.fillText(s.label, 10, cy);
    });

    // Content (risers + blocks) drawn at reduced opacity so the background
    // shows through the viz itself, not just the panel.
    const contentAlpha = clamp01(state.options.contentOpacity ?? DEFAULT_CONTENT_OPACITY);
    ctx.globalAlpha = contentAlpha;

    // Risers first (so blocks sit on top), colored by the destination stage.
    for (let i = 1; i < state.segments.length; i++) {
        const cur = state.segments[i];
        if (cur.startMin <= viewStart || cur.startMin >= viewEnd) continue; // outside zoom
        const prev = state.segments[i - 1];
        const x = xOf(cur.startMin);
        const y1 = laneCenter(state.laneOf[prev.stage]);
        const y2 = laneCenter(state.laneOf[cur.stage]);
        ctx.strokeStyle = hexAlpha(state.colorOf[cur.stage], 0.55);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x), Math.min(y1, y2));
        ctx.lineTo(Math.round(x), Math.max(y1, y2));
        ctx.stroke();
    }

    // Blocks (clipped to the visible zoom window)
    state.hitRects = [];
    for (const s of state.segments) {
        const s0 = Math.max(s.startMin, viewStart);
        const s1 = Math.min(s.endMin, viewEnd);
        if (s1 <= s0) continue; // fully outside the window
        const x = xOf(s0);
        const wd = Math.max(1.5, xOf(s1) - x);
        const cy = laneCenter(state.laneOf[s.stage]);
        const y = cy - blockH / 2;
        ctx.fillStyle = state.colorOf[s.stage];
        roundRectPath(ctx, x, y, wd, blockH, 3);
        ctx.fill();
        state.hitRects.push({ x, y, w: wd, h: blockH, seg: s });
    }

    ctx.globalAlpha = 1; // restore for axis/labels

    // Time axis
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.grid;
    ctx.font = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const axisY = padT + plotH + 6;
    const ticks = visibleTicks(viewStart, viewEnd);
    let lastX = -Infinity;
    let lastDate = null;
    let firstTick = true;
    for (const t of ticks) {
        const x = xOf(t.min);
        if (x < padL - 0.5 || x > padL + plotW + 0.5) continue; // outside window
        if (x - lastX < 34) continue; // avoid crowding
        lastX = x;
        ctx.strokeStyle = c.grid;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, padT + plotH);
        ctx.lineTo(Math.round(x) + 0.5, padT + plotH + (t.major ? 6 : 4));
        ctx.stroke();
        // Date (major) ticks are brighter and bold; hour ticks are muted.
        ctx.fillStyle = t.major ? c.text : c.muted;
        ctx.font = (t.major ? '600 ' : '') + '11px -apple-system, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(t.label, x, axisY);
        // Single-day tick date line: stamp the date under the first drawn tick
        // and whenever it changes (a midnight crossing), so a one-night timeline
        // says which night it is. Multi-day ticks carry the date in `label`
        // already (t.date is unset there), so this stays a no-op for them.
        if (t.date) {
            if (firstTick || t.date !== lastDate) {
                ctx.fillStyle = c.muted;
                ctx.font = '600 10px -apple-system, "Segoe UI", Roboto, sans-serif';
                ctx.fillText(t.date, x, axisY + 12);
            }
            lastDate = t.date;
        }
        firstTick = false;
    }

    // Live brush selection rectangle while dragging.
    if (state.dragging) {
        const bx1 = Math.min(state.dragStartX, state.dragCurX);
        const bx2 = Math.max(state.dragStartX, state.dragCurX);
        ctx.fillStyle = 'rgba(120,160,220,0.18)';
        ctx.fillRect(bx1, padT, bx2 - bx1, plotH);
        ctx.strokeStyle = 'rgba(120,160,220,0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx1 + 0.5, padT); ctx.lineTo(bx1 + 0.5, padT + plotH);
        ctx.moveTo(bx2 - 0.5, padT); ctx.lineTo(bx2 - 0.5, padT + plotH);
        ctx.stroke();
    }

    // On-canvas "Reset zoom" button (only when zoomed). Rendered inside the viz
    // because a custom viz can't add controls to the DS panel header chrome.
    // Its bounds are cached in state.resetBtn for click hit-testing.
    state.resetBtn = null;
    if (state.view && !state.dragging) {
        // Match the native Dashboard Studio "⊖ Reset Zoom" control: a
        // circled-minus icon (drawn, not a glyph, so it renders identically
        // everywhere) + the same "Reset Zoom" label.
        const label = 'Reset Zoom';
        ctx.font = '600 11px -apple-system, "Segoe UI", Roboto, sans-serif';
        const textW = ctx.measureText(label).width;
        const iconR = 5;
        const padX = 9;
        const gap = 6;
        const bw = Math.ceil(padX + iconR * 2 + gap + textW + padX);
        const bh = 18;
        const bx = w - padR - bw;
        const by = 1;
        ctx.fillStyle = 'rgba(120,160,220,0.18)';
        ctx.strokeStyle = 'rgba(120,160,220,0.65)';
        ctx.lineWidth = 1;
        roundRectPath(ctx, bx, by, bw, bh, 4);
        ctx.fill();
        ctx.stroke();
        // circled-minus icon
        const icx = bx + padX + iconR;
        const icy = by + bh / 2;
        ctx.strokeStyle = c.text;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(icx, icy, iconR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(icx - iconR * 0.55, icy);
        ctx.lineTo(icx + iconR * 0.55, icy);
        ctx.stroke();
        // label
        ctx.fillStyle = c.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + padX + iconR * 2 + gap, icy + 0.5);
        state.resetBtn = { x: bx, y: by, w: bw, h: bh };
    }
}

// Ticks within the visible window. If a narrow zoom leaves fewer than 2,
// synthesize edge labels from the base clock time (segment[0] starts at
// normalized minute 0, so any minute m -> base + m).
function visibleTicks(viewStart, viewEnd) {
    const within = state.ticks.filter((t) => t.min >= viewStart - 1e-6 && t.min <= viewEnd + 1e-6);
    if (within.length >= 2) return within;
    // Carry the date onto the synthesized edge ticks too — a night whose 5-min
    // rows never land on :00 (e.g. bedtime 01:52 → offsets :52/:57/:02/…) yields
    // NO on-the-hour ticks, so the axis is just these two edges; without a date
    // here the date line would never render.
    const base = (state.segments[0] && state.segments[0].startLabel) || '';
    return [
        { min: viewStart, label: addMinutes(base, Math.round(viewStart)), date: state.startDate, major: false },
        { min: viewEnd, label: addMinutes(base, Math.round(viewEnd)), date: state.endDate, major: false },
    ];
}

function hexAlpha(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

function showMessage(text) {
    canvas.style.display = 'none';
    tooltip.style.display = 'none';
    message.textContent = text;
    message.style.display = 'flex';
}

/* --------------------------- interactivity ------------------------ */

function fmtDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

function hitTest(cx, cy) {
    // small vertical padding so thin blocks are easier to hover
    for (const r of state.hitRects) {
        if (cx >= r.x && cx <= r.x + r.w && cy >= r.y - 4 && cy <= r.y + r.h + 4) return r;
    }
    return null;
}

/* ------------------------- brush-to-zoom -------------------------- *
 * Drag horizontally across the plot to zoom into that time window
 * (client-side visual zoom — no re-query; source granularity is fixed).
 * Double-click resets. Disabled in DS edit mode so it doesn't fight the
 * panel editor. A press that doesn't move past DRAG_THRESHOLD is treated
 * as a hover, not a zoom.
 * ----------------------------------------------------------------- */
const DRAG_THRESHOLD = 4; // px of movement before a press becomes a zoom-drag

function clampX(x) {
    const g = state.geom;
    if (!g) return x;
    return Math.max(g.padL, Math.min(g.padL + g.plotW, x));
}
function inPlot(x, y) {
    const g = state.geom;
    if (!g) return false;
    return x >= g.padL && x <= g.padL + g.plotW && y >= g.padT && y <= g.padT + g.plotH;
}
function inButton(x, y) {
    const b = state.resetBtn;
    return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}
function minAtX(x) {
    const g = state.geom;
    if (!g) return 0;
    return g.viewStart + ((clampX(x) - g.padL) / g.plotW) * g.span;
}
function evtXY(e) {
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
}

canvas.addEventListener('mousedown', (e) => {
    if (state.mode === 'edit') return;
    const [cx, cy] = evtXY(e);
    if (inButton(cx, cy)) { state.view = null; render(); return; } // reset zoom
    if (!inPlot(cx, cy)) return;
    state.mouseDown = true;
    state.dragging = false;
    state.dragStartX = clampX(cx);
    state.dragCurX = clampX(cx);
});

canvas.addEventListener('mousemove', (e) => {
    const [cx, cy] = evtXY(e);

    // Dragging a zoom selection takes over from hover.
    if (state.mouseDown) {
        if (!state.dragging && Math.abs(cx - state.dragStartX) > DRAG_THRESHOLD) {
            state.dragging = true;
            tooltip.style.display = 'none';
        }
        if (state.dragging) {
            state.dragCurX = clampX(cx);
            canvas.style.cursor = 'ew-resize';
            render();
            return;
        }
    }

    // Reset button hover — pointer cursor, no tooltip.
    if (inButton(cx, cy)) {
        tooltip.style.display = 'none';
        canvas.style.cursor = 'pointer';
        return;
    }

    // Hover tooltip.
    const hit = hitTest(cx, cy);
    if (!hit) {
        tooltip.style.display = 'none';
        // crosshair over the plot signals "drag here to zoom"
        canvas.style.cursor = inPlot(cx, cy) && state.mode !== 'edit' ? 'crosshair' : 'default';
        return;
    }
    const s = hit.seg;
    canvas.style.cursor = 'pointer';
    tooltip.innerHTML =
        `<div class="hyp-tip-title"><span class="hyp-tip-dot" style="background:${state.colorOf[s.stage]}"></span>${s.stage}</div>` +
        `<div class="hyp-tip-row">${s.startLabel} – ${s.endLabel}</div>` +
        `<div class="hyp-tip-row hyp-tip-dur">${fmtDur(s.durMin)}</div>`;
    tooltip.style.display = 'block';
    // position, keeping inside container
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = cx + 14;
    let top = cy - th - 12;
    if (left + tw > state.width) left = cx - tw - 14;
    if (top < 0) top = cy + 16;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
});

canvas.addEventListener('mouseup', () => {
    if (!state.mouseDown) return;
    const wasDragging = state.dragging;
    state.mouseDown = false;
    state.dragging = false;
    if (!wasDragging) return; // plain click — not a zoom
    const lo = Math.min(minAtX(state.dragStartX), minAtX(state.dragCurX));
    const hi = Math.max(minAtX(state.dragStartX), minAtX(state.dragCurX));
    if (hi - lo < state.slotMin) { render(); return; } // window too small — ignore
    state.view = { startMin: lo, endMin: hi };
    render();
});

canvas.addEventListener('mouseleave', () => {
    // Cancel an in-progress drag (release happened off-canvas).
    const wasDragging = state.dragging;
    state.mouseDown = false;
    state.dragging = false;
    tooltip.style.display = 'none';
    canvas.style.cursor = 'default';
    if (wasDragging) render();
});

canvas.addEventListener('dblclick', () => {
    if (state.view) { state.view = null; render(); }
});

/* ----------------------------- listeners -------------------------- */

// Options MUST be registered first and invoked immediately: render() resolves
// lanes/colors from state.options every pass, and the data/dimensions/theme
// listeners below also fire immediately. If options weren't populated first,
// an early data-driven render would resolve lanes from the AUTO_PALETTE
// fallback (wrong colors + data-derived order) — a race that surfaced as
// "correct on first load, wrong after a refresh" (warm cache reorders the
// callbacks). invokeImmediately guarantees state.options is set before any draw.
VisualizationAPI.addOptionsListener(
    ({ options }) => {
        state.options = options || {};
        state.segments = []; // lanes/slotMinutes can change the model — force rebuild
        state.view = null; // lane/slot change invalidates any zoom window
        render();
    },
    { invokeImmediately: true }
);

VisualizationAPI.addDataSourcesListener(
    ({ dataSources, loading }) => {
        state.loading = loading;
        state.data = dataSources?.primary?.data || null;
        state.segments = []; // force rebuild
        state.view = null; // new time range invalidates any zoom window
        render();
    },
    { invokeImmediately: true }
);

VisualizationAPI.addDimensionsListener(
    ({ width, height }) => {
        state.width = width;
        state.height = height;
        render();
    },
    { invokeImmediately: true }
);

VisualizationAPI.addThemeListener(
    ({ theme }) => {
        state.theme = theme;
        render();
    },
    { invokeImmediately: true }
);

// Track edit vs view mode so the brush-zoom doesn't fight the panel editor.
VisualizationAPI.addModeListener(
    ({ mode }) => {
        state.mode = mode;
    },
    { invokeImmediately: true }
);

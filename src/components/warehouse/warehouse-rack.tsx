"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GantryStatus } from "@/lib/gantry/types";
import { isGantryStation } from "@/lib/gantry/types";
import type { BinView, InventoryAuditView, MovementRowView } from "@/lib/warehouse/dashboard-types";
import { groupBinsInShelfOrder } from "@/lib/warehouse/bin-layout";
import { parseBinCode } from "@/lib/warehouse/types";
import { deriveRackArmState, type RackArmState } from "@/lib/warehouse/rack-arm-state";
import { usePrefersReducedMotion } from "./use-reduced-motion";
import { useAuditCapture } from "./audit-capture-dialog";
import { useWarehouseSession } from "./session";
import { CaptureStation, ScanResultDialog } from "./capture-station";
import { AuditCaptureModeToggle } from "./audit-capture-mode-toggle";
import { BUTTON_VARIANTS, ErrorNote } from "./ui";

type Point = { x: number; y: number };
const DOCK: Point = { x: 155, y: 255 };
const HOME: Point = { x: 278, y: 104 };
const AISLE_X = 278;
const TOP = 120;
const PITCH = 174;
const BIN_BASE = 112;

function geometryFor(bins: BinView[]) {
  const rows = groupBinsInShelfOrder(bins);
  const columns = Math.max(3, ...rows.map((row) => row.bins.length), ...bins.map((bin) => parseBinCode(bin.code)?.slot ?? 1));
  const width = Math.max(980, 388 + columns * 120);
  const height = Math.max(600, TOP + rows.length * PITCH + 65);
  const points = new Map<string, Point>();
  rows.forEach((row, r) => row.bins.forEach((bin, c) => {
    const column = (parseBinCode(bin.code)?.slot ?? c + 1) - 1;
    points.set(bin.code, { x: 394 + column * ((width - 425) / columns), y: TOP + r * PITCH + BIN_BASE });
  }));
  return { rows, width, height, points };
}
type Geometry = ReturnType<typeof geometryFor>;
function locationPoint(location: string | null | undefined, geometry: Geometry): Point {
  if (!location) return HOME;
  return isGantryStation(location) ? DOCK : geometry.points.get(location) ?? HOME;
}

/** Withdraw into the clear aisle, change height, then extend into the bay.
 * No diagonal path through neighbouring totes or shelf boards. */
function travelPoint(from: Point, to: Point, progress: number): Point {
  if (from.y === to.y) return { x: from.x + (to.x - from.x) * progress, y: to.y };
  const stops = [from, { x: AISLE_X, y: from.y }, { x: AISLE_X, y: to.y }, to];
  const lengths = stops.slice(1).map((p, i) => Math.abs(p.x - stops[i].x) + Math.abs(p.y - stops[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total) return to;
  let distance = progress * total;
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] && lengths[i] > 0) {
      const t = distance / lengths[i];
      return { x: stops[i].x + (stops[i + 1].x - stops[i].x) * t,
        y: stops[i].y + (stops[i + 1].y - stops[i].y) * t };
    }
    distance -= lengths[i];
  }
  return to;
}

function itemNameLines(name: string): string[] {
  const words = name.trim().split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const index = lines.length - 1;
    const next = `${lines[index]} ${word}`.trim();
    if (next.length <= 17) lines[index] = next;
    else if (lines.length === 1 && lines[0]) lines.push(word);
    else { lines[index] = `${next.slice(0, 16).trimEnd()}…`; break; }
  }
  return lines.map((line) => line.length > 17 ? `${line.slice(0, 16)}…` : line);
}

function BinItemLabel({ name, quantity }: { name: string; quantity?: number }) {
  return <g>
    <rect x="-54" y="13" width="108" height="34" rx="5" fill="#0b1823" fillOpacity=".92" />
    <text textAnchor="middle" fill="#d4e5ed" fontSize="10.5" fontWeight="500">
      {itemNameLines(name).map((line, index) => <tspan key={index} x="0" y={27 + index * 13}>{line}</tspan>)}
    </text>
    {quantity !== undefined && <g>
      <rect x="7" y="-98" width="55" height="23" rx="7" fill="#c8f3fa" stroke="#89d9ea" />
      <text x="34.5" y="-82" textAnchor="middle" fill="#10313e" fontSize={quantity > 9999 ? 10 : 13} fontWeight="700">
        {quantity.toLocaleString("en-US")}<tspan fontSize="8" fontWeight="500"> pcs</tspan>
      </text>
    </g>}
  </g>;
}

/** The saved photo is a visual inventory label, not an inferred item count. */
const Tote = memo(function Tote({ code, quantity: providedQuantity, bin, tone = "stock", active = false }: {
  code: string; quantity?: number; bin?: BinView; tone?: "stock" | "empty" | "reserved"; active?: boolean;
}) {
  const clipId = useId().replace(/:/g, "");
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const quantity = bin?.totalQuantity ?? providedQuantity;
  const item = quantity !== 0 ? bin?.contents[0] : undefined;
  const photo = item ? item.catalogImageUrl ?? item.imageUrl ?? bin?.latestSnapshot?.imageUrl : null;
  const name = item?.canonicalName ?? (quantity === 0 ? "Empty bin" : "No recorded item");
  const front = tone === "empty" ? "#263844" : tone === "reserved" ? "#625136" : "#23516a";
  const edge = active ? "#9aeeff" : tone === "reserved" ? "#d6ab64" : "#54849a";
  return <g className="machine-tote">
    <ellipse cx="2" cy="5" rx="48" ry="9" fill="#000" opacity=".35" />
    <path d="M-47 -75 L-31 -92 L49 -92 L44 -75Z" fill="#507486" stroke={edge} />
    <path d="M-40 -74 L-28 -85 L39 -85 L35 -74Z" fill="#0b1b25" />
    <path d="M44 -75 L49 -92 L45 -14 L37 1Z" fill="#193747" stroke={edge} strokeOpacity=".5" />
    <path d="M-47 -75 L44 -75 L37 1 L-40 1Z" fill={front} stroke={edge} strokeWidth={active ? 1.8 : 1} />
    <path d="M-46 -72 H43 M-39 -65 L-32 -6 M37 -65 L28 -6" stroke="#a1d7e3" strokeOpacity=".15" strokeWidth="2" />
    <defs><clipPath id={clipId}><rect x="-34" y="-67" width="68" height="43" rx="4" /></clipPath></defs>
    <rect x="-34" y="-67" width="68" height="43" rx="4" fill="#0c202c" stroke={edge} strokeOpacity=".4" />
    {photo && failedImage !== photo ? <image href={photo} x="-34" y="-67" width="68" height="43"
      preserveAspectRatio="xMidYMid meet" clipPath={`url(#${clipId})`} onError={() => setFailedImage(photo)} />
      : <g fill="none" stroke="#678b9d" strokeWidth="1.3">
        <path d="M-10 -55 L0 -60 L10 -55 L10 -43 L0 -38 L-10 -43Z M-10 -55 L0 -50 L10 -55 M0 -50 V-38" />
        <text x="0" y="-28" textAnchor="middle" stroke="none" fill="#8da9b8" fontSize="7">{quantity === 0 ? "EMPTY" : "NO PHOTO"}</text>
      </g>}
    <rect x="-28" y="-20" width="55" height="17" rx="3" fill="#e0e7df" />
    <text x="0" y="-8" textAnchor="middle" fill="#17252d" fontSize="11" fontWeight="700">{code}</text>
    <BinItemLabel name={name} quantity={quantity} />
  </g>;
});

/** Ordered visual playback: telemetry chooses phases, never a fresh origin
 * for an already moving carriage. Carry/release and shelf occupancy share
 * this same phase so a bin cannot teleport ahead of its carriage. */
function useGantryPlayback(input: GantryStatus | null, geometry: Geometry) {
  const reduced = usePrefersReducedMotion();
  const initial = locationPoint(input?.currentLocation, geometry);
  const [view, setView] = useState({ gantry: input, point: initial });
  const shown = useRef(initial);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const keyRef = useRef("");
  const queue = useRef<GantryStatus[]>([]);
  const frame = useRef<number | null>(null);
  const work = useRef<{ gantry: GantryStatus; from: Point; to: Point; started: number; duration: number } | null>(null);

  useEffect(() => {
    if (!input) return;
    const key = [input.activeOperationId, input.operation?.operationId, input.state,
      input.motion?.startedAt, input.currentLocation, input.lastError].join("|");
    if (key === keyRef.current) return;
    keyRef.current = key;
    if (input.state === "OFFLINE" || input.state === "ERROR" || (input.state === "IDLE" && input.lastError)) {
      queue.current = []; work.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setView({ gantry: input, point: shown.current });
      return;
    }

    // A completed home reading is the controller's authoritative final pose.
    // Drop stale shelf frames that may still be queued after a slow render and
    // smoothly finish from the currently displayed point instead.
    const settledAtHome = input.state === "IDLE"
      && input.currentLocation === null
      && input.activeOperationId === null;
    if (settledAtHome) {
      queue.current = [];
      work.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    queue.current.push(input);
    if (frame.current !== null) return;
    function tick(now: number) {
      if (!work.current) {
        const status = queue.current.shift();
        if (!status) { frame.current = null; return; }
        const to = locationPoint(status.motion ? status.motion.to : status.currentLocation, geometryRef.current);
        const finalHome = status.state === "IDLE"
          && status.currentLocation === null
          && status.activeOperationId === null;
        const remaining = status.motion
          ? status.motion.durationMs - status.motion.elapsedMs
          : finalHome ? 650 : 220;
        work.current = { gantry: status, from: shown.current, to, started: now,
          duration: Math.max(status.state === "MOVING" || status.state === "HOMING" ? 350 : 120, remaining) };
      }
      const step = work.current;
      const progress = reducedRef.current ? 1 : Math.min(1, (now - step.started) / step.duration);
      const eased = progress * progress * (3 - 2 * progress);
      const moving = step.gantry.state === "MOVING" || step.gantry.state === "HOMING";
      const point = moving ? travelPoint(step.from, step.to, eased) : {
        x: step.from.x + (step.to.x - step.from.x) * eased,
        y: step.from.y + (step.to.y - step.from.y) * eased,
      };
      shown.current = point;
      setView({ gantry: step.gantry, point });
      if (progress === 1) work.current = null;
      frame.current = requestAnimationFrame(tick);
    }
    frame.current = requestAnimationFrame(tick);
  }, [input]);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return view;
}

function Carriage({ arm, point, bin }: { arm: RackArmState; point: Point; bin?: BinView }) {
  const handling = arm.phase === "PICKING" || arm.phase === "DROPPING";
  return <g aria-hidden="true">
    <g transform={`translate(0 ${point.y})`}>
      <rect x="263" y="-34" width="30" height="52" rx="5" fill="#60717d" stroke="#a2bac9" />
      <rect x="268" y="-25" width="20" height="32" rx="3" fill="#182a38" />
      <circle cx="278" cy="-10" r="5" fill={arm.phase === "FAULT" ? "#fb7185" : "#83e1f6"} />
      <path d={`M278 4 H${point.x}`} stroke="#111e29" strokeWidth="15" strokeLinecap="round" />
      <path d={`M278 0 H${point.x}`} stroke="#778c9b" strokeWidth="5" />
    </g>
    <g transform={`translate(${point.x} ${point.y})`}>
      {arm.carrying && <Tote code={arm.focusBin ?? "BIN"} bin={bin} active />}
      <g className={handling ? "machine-grip" : ""}>
        <path d="M-49 -8 V8 H49 V-8" fill="none" stroke="#b6cbd7" strokeWidth="4" strokeLinejoin="round" />
        <path d="M-49 -8 V-22 M49 -8 V-22" stroke="#76e4f4" strokeWidth="5" strokeLinecap="round" />
      </g>
      <rect x="-32" y="9" width="64" height="7" rx="3" fill="#314b5b" />
    </g>
  </g>;
}

const Structure = memo(function Structure({ geometry, id }: { geometry: Geometry; id: string }) {
  const right = geometry.width - 45;
  const bottom = TOP + geometry.rows.length * PITCH;
  return <g aria-hidden="true">
    {/* Back uprights, diagonal bracing and recessed bays create real shelf depth. */}
    <path d={`M371 81 L${right + 18} ${bottom - 20} M${right + 18} 81 L371 ${bottom - 20}`}
      stroke="#2e414d" strokeWidth="4" opacity=".45" />
    {[365, right + 17].map((x) => <rect key={x} x={x} y="79" width="12" height={bottom - 65} fill="#253743" />)}
    {geometry.rows.map((row, index) => {
      const y = TOP + index * PITCH + BIN_BASE + 12;
      return <g key={row.bed ?? "other"}>
        <path d={`M337 ${y} L367 ${y - 24} H${right + 28} L${right} ${y}Z`} fill={`url(#${id}-shelf)`} stroke="#506675" />
        <rect x="337" y={y} width={right - 337} height="13" rx="2" fill="#233442" stroke="#4b606e" />
        <path d={`M344 ${y + 2} H${right - 5}`} stroke="#b1c7d4" strokeOpacity=".25" />
        <rect x="342" y={y + 3} width="38" height="8" rx="2" fill="#111e2a" />
        <text x="360" y={y + 10} fill="#8aa5b7" textAnchor="middle" fontSize="7">BED {row.bed ?? "—"}</text>
      </g>;
    })}
    {[330, right].map((x) => <g key={x}>
      <path d={`M${x} 97 L${x + 13} 85 L${x + 13} ${bottom + 18} L${x} ${bottom + 30}Z`} fill="#465a68" />
      <rect x={x - 9} y="97" width="13" height={bottom - 67} rx="2" fill={`url(#${id}-steel)`} stroke="#617483" strokeWidth=".7" />
      {Array.from({ length: Math.floor((bottom - 100) / 17) }, (_, i) =>
        <rect key={i} x={x - 5} y={112 + i * 17} width="4" height="7" rx="1.5" fill="#07111a" />)}
      <path d={`M${x - 17} ${bottom + 31} H${x + 17} L${x + 25} ${bottom + 23} H${x - 9}Z`} fill="#506370" />
    </g>)}
    <path d={`M323 99 L354 76 H${right + 28} L${right + 2} 99Z`} fill="#3a5262" stroke="#637c8d" />
    <rect x="323" y="98" width={right - 321} height="13" rx="2" fill="#213542" stroke="#4c6576" />
    <text x="345" y="64" fill="#7c99ac" fontSize="10" letterSpacing="3">STORAGE ARRAY</text>
    {/* Lead screw and guide rails, independent of the shelf frame. */}
    <rect x="262" y="85" width="32" height={bottom - 50} rx="8" fill="#0d1b27" stroke="#354e61" />
    <path d={`M266 98 V${bottom + 23} M290 98 V${bottom + 23}`} stroke="#7b94a5" strokeWidth="3" />
    <rect x="276" y="99" width="4" height={bottom - 78} fill={`url(#${id}-screw)`} />
    <rect x="262" y={bottom + 28} width="33" height="27" rx="4" fill="#304958" stroke="#617b8d" />
    <circle cx="278" cy={bottom + 41} r="7" fill="#112532" stroke="#89a5b5" />
  </g>;
});

function CameraRig({ scanning, dockBin, scanImage }: { scanning: boolean; dockBin?: BinView; scanImage?: string }) {
  return <g aria-hidden="true">
    <text x="55" y="64" fill="#8aa7b9" fontSize="10" letterSpacing="2">VISION / CHECKOUT</text>
    <path d="M62 284 V92 H148 V116" fill="none" stroke="#152835" strokeWidth="14" strokeLinejoin="round" />
    <path d="M59 280 V90 H146" fill="none" stroke="#587183" strokeWidth="3" />
    {/* Raspberry Pi enclosure, side ports and a downward-facing lens. */}
    <path d="M117 104 L131 94 H184 L170 104Z" fill="#546b7a" stroke="#7694a5" />
    <path d="M170 104 L184 94 V124 L170 135Z" fill="#213b4b" stroke="#486574" />
    <rect x="115" y="104" width="56" height="31" rx="5" fill="#364e5f" stroke="#8aa8b9" />
    <rect x="122" y="111" width="20" height="14" rx="2" fill="#214634" stroke="#588369" />
    <rect x="127" y="113" width="8" height="8" rx="1" fill="#142b24" />
    <path d="M149 111 V126 M154 111 V126 M159 111 V126" stroke="#152a38" strokeWidth="2" />
    <circle cx="165" cy="109" r="2" fill={scanning ? "#6ee7b7" : "#b3cbaa"} />
    <path d="M137 136 L143 143 H162 L168 136" fill="#122d3d" stroke="#68889b" />
    <ellipse cx="152" cy="143" rx="10" ry="4" fill="#092536" stroke="#79d9ed" />
    <ellipse cx="152" cy="143" rx="5" ry="2" fill={scanning ? "#a5f3fc" : "#3b859c"} />
    <text x="88" y="320" fill="#90a6b6" fontSize="9" letterSpacing="1">RASPBERRY PI 5 STATION</text>
    <g transform="translate(0 30)">
    <path d="M83 235 L108 216 H228 L204 235Z" fill="#436171" stroke="#789baa" />
    <path d="M83 235 H204 V244 H83Z" fill="#263f50" stroke="#567182" />
    <path d="M204 235 L228 216 V225 L204 244Z" fill="#1c3342" />
    <path d="M94 245 V263 M194 245 V263" stroke="#516977" strokeWidth="9" />
    {dockBin ? <g transform="translate(155 225)"><Tote code={dockBin.code} bin={dockBin} active={scanning} /></g>
      : <path d="M121 226 H182 M152 219 V232" stroke="#87a9ba" strokeOpacity=".5" />}
    <rect x="83" y="308" width="145" height="56" rx="8" fill="#0b1d2a" stroke={scanning ? "#5299ae" : "#294353"} />
    <circle cx="98" cy="326" r="3" fill={scanning ? "#67e8f9" : dockBin ? "#f4c078" : "#6a879a"} />
    <text x="109" y="330" fill="#c2d8e4" fontSize="10">{scanning ? "ANALYZING FRAME" : dockBin ? "BIN AT STATION" : "STATION READY"}</text>
    <text x="98" y="348" fill="#7e9aaf" fontSize="9">{dockBin?.code ?? "Capture when positioned"}</text>
    </g>
    {scanning && <g>
      {scanImage && <g>
        <rect x="103" y="174" width="104" height="74" rx="5" fill="#09232d" stroke="#74d5e8" />
        <image href={scanImage} x="106" y="177" width="98" height="68" preserveAspectRatio="xMidYMid meet" />
      </g>}
      <g className="machine-scan-cone">
        <path d="M144 147 L102 251 H207 L159 147Z" fill="#5ce1f4" fillOpacity=".09" />
        <path d="M144 147 L102 251 M159 147 L207 251" stroke="#67e8f9" strokeOpacity=".5" strokeDasharray="4 5" />
        <ellipse className="machine-scan-ring" cx="155" cy="243" rx="49" ry="10" fill="none" stroke="#8dedf8" strokeWidth="2" />
      </g>
    </g>}
  </g>;
}

/** A code-native, perspective machine scene. Only telemetry drives movement;
 * the database still owns stock, capacity and availability. */
export function WarehouseRack({ bins, loading, error, onRetry, gantry: rawGantry, activeMovement, latestAudit, onManageBins, onSelectBin }: {
  bins: BinView[]; loading: boolean; error: string | null; onRetry: () => void;
  gantry: GantryStatus | null; activeMovement: MovementRowView | null;
  latestAudit: InventoryAuditView | null; onManageBins?: () => void; onSelectBin?: (bin: BinView) => void;
}) {
  const id = useId().replace(/:/g, "");
  const geometry = useMemo(() => geometryFor(bins), [bins]);
  const { gantry, point } = useGantryPlayback(rawGantry, geometry);
  const arm = deriveRackArmState({ gantry, activeMovement, latestAudit });
  const audit = useAuditCapture();
  const session = useWarehouseSession();
  const scanning = session.scanning || audit.submitting;
  const operation = gantry?.operation;
  const currentAtStation = !!gantry?.currentLocation && isGantryStation(gantry.currentLocation);
  const checkedOut = bins.filter((bin) => bin.status === "CHECKED_OUT");
  const activeBin = bins.find((bin) => bin.code === arm.focusBin);
  const isReturn = operation?.destination && !isGantryStation(operation.destination);
  const returned = operation?.status === "COMPLETED" && isReturn ? operation.destination : null;
  const dockBin = !arm.carrying && currentAtStation && operation?.status !== "FAILED"
    && (operation?.status === "COMPLETED" || operation?.source && isGantryStation(operation.source))
    ? activeBin ?? checkedOut.find((bin) => bin.code !== returned)
    : !gantry?.activeOperationId && !arm.carrying ? checkedOut.find((bin) => bin.code !== returned) : null;
  const presented = dockBin?.code ?? null;

  return <section className="machine-panel flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-line" aria-label="Warehouse machine visualization">
    <div className="machine-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div>
        <p className="font-mono text-[10px] tracking-[.22em] text-accent">WAREHOUSE / LIVE SCENE</p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-ink">Your warehouse, in motion.</h2>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <CaptureStation />
        {onManageBins && <button type="button" onClick={onManageBins} className={BUTTON_VARIANTS.secondary}>Manage bins</button>}
        <AuditCaptureModeToggle />
      </div>
    </div>
    {error && <div className="px-5 pb-3"><ErrorNote onRetry={onRetry}>{error}</ErrorNote></div>}
    {loading && bins.length === 0 ? <div className="flex h-80 items-center justify-center text-sm text-ink-muted" role="status">Loading your warehouse…</div>
      : bins.length === 0 ? <div className="p-12 text-center text-sm text-ink-muted">No bins yet. Add bins to build your storage rack.</div>
      : <div className="machine-scene min-h-0 flex-1 overflow-hidden">
        <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          className="machine-scene-svg block w-full font-mono"
          preserveAspectRatio="xMidYMid meet"
          role="group" aria-label="Interactive storage rack. Select a bin to inspect its contents.">
          <defs>
            <linearGradient id={`${id}-steel`} x2="1" y2="0"><stop stopColor="#162c3a" /><stop offset=".45" stopColor="#526979" /><stop offset="1" stopColor="#203646" /></linearGradient>
            <linearGradient id={`${id}-shelf`} x2=".2" y2="1"><stop stopColor="#142634" /><stop offset="1" stopColor="#4c626f" /></linearGradient>
            <pattern id={`${id}-screw`} width="4" height="7" patternUnits="userSpaceOnUse"><rect width="4" height="7" fill="#6d8596" /><path d="M0 6 L4 2" stroke="#1c3344" strokeWidth="2" /></pattern>
            <pattern id={`${id}-floor`} width="48" height="24" patternUnits="userSpaceOnUse"><path d="M0 24 L24 0 L48 24 M0 0 H48" fill="none" stroke="#557e96" strokeOpacity=".1" /></pattern>
            <radialGradient id={`${id}-light`}><stop stopColor="#24718e" stopOpacity=".18" /><stop offset="1" stopColor="#112431" stopOpacity="0" /></radialGradient>
          </defs>
          <rect width={geometry.width} height={geometry.height} fill={`url(#${id}-light)`} />
          <path d={`M25 ${geometry.height - 115} L${geometry.width - 120} ${geometry.height - 175} L${geometry.width} ${geometry.height} H0Z`} fill={`url(#${id}-floor)`} />
          <ellipse cx={geometry.width * .61} cy={geometry.height - 38} rx={geometry.width * .33} ry="23" fill="#020911" opacity=".6" />
          <Structure geometry={geometry} id={id} />
          {geometry.rows.flatMap((row) => row.bins.map((bin) => {
            const point = geometry.points.get(bin.code)!;
            const approachingPickup = !!gantry?.activeOperationId && operation?.source === bin.code && !arm.carrying;
            const absent = (!approachingPickup && bin.status === "CHECKED_OUT" && bin.code !== returned)
              || bin.code === presented || (arm.carrying && bin.code === arm.focusBin);
            return <g key={bin.binId} transform={`translate(${point.x} ${point.y})`}
              className="machine-bin cursor-pointer outline-none" role="button" tabIndex={onSelectBin ? 0 : undefined}
              aria-label={`${bin.code}, ${bin.contents[0]?.canonicalName ?? "Empty bin"}, ${bin.status.replaceAll("_", " ").toLowerCase()}, ${bin.totalQuantity} on record. View bin.`}
              onClick={() => onSelectBin?.(bin)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectBin?.(bin); } }}>
              <title>{bin.code} · {bin.status} · {bin.contents[0]?.canonicalName ?? "No recorded contents"}</title>
              <rect className="machine-bin-focus" x="-55" y="-103" width="119" height="155" rx="9" fill="transparent" stroke="transparent" />
              {absent ? <g>
                <path d="M-44 -43 L40 -43 L35 1 H-38Z" fill="#142532" fillOpacity=".3" stroke="#607583" strokeDasharray="4 5" />
                <text x="0" y="-19" textAnchor="middle" fill="#9fb3c2" fontSize="11">{bin.code}</text>
                <text x="0" y="-3" textAnchor="middle" fill="#d2b280" fontSize="9">{bin.status === "CHECKED_OUT" ? "CHECKED OUT" : "IN TRANSIT"}</text>
                <BinItemLabel name={bin.contents[0]?.canonicalName ?? "Empty bin"} quantity={bin.totalQuantity} />
              </g> : <Tote code={bin.code} bin={bin}
                tone={bin.status === "AVAILABLE" ? "empty" : bin.status === "OCCUPIED" ? "stock" : "reserved"}
                active={bin.code === arm.focusBin && !!gantry?.activeOperationId} />}
            </g>;
          }))}
          <CameraRig scanning={scanning} dockBin={dockBin ?? undefined}
            scanImage={session.scanning ? session.shots[0]?.dataUrl : audit.submitting ? audit.imageDataUrl ?? undefined : undefined} />
          <Carriage arm={arm} point={point} bin={activeBin} />
        </svg>
      </div>}
    <div className="machine-status flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
      <p className="flex items-center gap-2 text-xs text-ink-muted" role="status">
        <span className={`h-1.5 w-1.5 rounded-full ${arm.phase === "FAULT" ? "bg-danger" : "bg-accent"}`} />
        {scanning ? "Analyzing captured frame · camera station" : arm.label}
      </p>
      <div className="flex gap-3 font-mono text-[9px] text-ink-faint">
        <span>{bins.length} SLOTS</span><span>{checkedOut.length} CHECKED OUT</span><span>SELECT A BIN TO INSPECT</span>
      </div>
    </div>
    {checkedOut.length > 0 && <p className="machine-checkout-note shrink-0 border-t border-line px-5 py-3 text-xs text-ink-muted">
      Checked out: {checkedOut.map((bin) => bin.code).join(", ")}. Stock remains recorded; putaway returns the bin to its shelf.
    </p>}
    <div className="shrink-0 px-4 pb-3 empty:hidden"><ScanResultDialog /></div>
  </section>;
}

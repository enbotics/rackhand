"use client";

import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GantryStatus } from "@/lib/gantry/types";
import { isGantryStation } from "@/lib/gantry/types";
import type {
  BinView,
  InventoryAuditView,
  MovementRowView,
} from "@/lib/warehouse/dashboard-types";
import { groupBinsInShelfOrder } from "@/lib/warehouse/bin-layout";
import { parseBinCode } from "@/lib/warehouse/types";
import {
  deriveRackArmState,
  type RackArmState,
} from "@/lib/warehouse/rack-arm-state";
import { usePrefersReducedMotion } from "./use-reduced-motion";
import { useAuditCapture } from "./audit-capture-dialog";
import { useWarehouseSession } from "./session";
import { CaptureStation, ScanResultDialog } from "./capture-station";
import { AuditCaptureModeToggle } from "./audit-capture-mode-toggle";
import { ErrorNote } from "./ui";
import { useCameraHealth } from "./camera-health-provider";

type Point = { x: number; y: number };
/**
 * THE LEFT COLUMN. Everything the checkout station occupies is derived here,
 * from one box and one scale, rather than from hand-placed magic numbers.
 *
 * CHECKOUT_ART is the box CameraRig draws itself inside, in its own
 * coordinates. The shelf frame's outer post starts at x=321, so the scale is
 * the largest that still leaves the station clear of it — grow the station by
 * raising CHECKOUT_SCALE and the dock, the tote and the card below all follow.
 */
const CHECKOUT_ART = { x: 31, y: 39, width: 214, height: 355 };
/**
 * The shelf and everything bolted to it (uprights, lead screw, aisle, bin
 * grid) slide right by this much, which is what buys the station its size.
 * It costs nothing on a real shelf: a six-bed scene is far taller than it is
 * wide, so fitting it into its panel is limited by HEIGHT, and the canvas has
 * unused width on both sides. Widening the canvas spends that, not the shelf.
 */
const SHELF_SHIFT = 170;
const CHECKOUT_SCALE = 1.9;
const CHECKOUT_LEFT = 10;
const CHECKOUT_TOP = 14;
const CHECKOUT_OFFSET: Point = {
  x: CHECKOUT_LEFT - CHECKOUT_ART.x * CHECKOUT_SCALE,
  y: CHECKOUT_TOP - CHECKOUT_ART.y * CHECKOUT_SCALE,
};
const CHECKOUT_WIDTH = CHECKOUT_ART.width * CHECKOUT_SCALE;
const CHECKOUT_BOTTOM = CHECKOUT_TOP + CHECKOUT_ART.height * CHECKOUT_SCALE;
/** The tote's own origin inside CameraRig (155, 225 + the 30 the dock group shifts). */
const DOCK: Point = {
  x: CHECKOUT_OFFSET.x + 155 * CHECKOUT_SCALE,
  y: CHECKOUT_OFFSET.y + 255 * CHECKOUT_SCALE,
};
/**
 * Directly under the station, same width, in the space the shelf never uses.
 * StationBinCard is drawn at CARD_ART size and scaled to the station's width,
 * so its type stays in proportion however big the station gets.
 */
const CARD_ART = { width: 304, height: 172 };
const CARD_SCALE = CHECKOUT_WIDTH / CARD_ART.width;
const STATION_CARD = {
  x: CHECKOUT_LEFT,
  y: CHECKOUT_BOTTOM + 24,
  width: CHECKOUT_WIDTH,
  height: CARD_ART.height * CARD_SCALE,
};
const AISLE_X = 278 + SHELF_SHIFT;
const HOME: Point = { x: AISLE_X, y: 104 };
const TOP = 120;
const PITCH = 174;
const BIN_BASE = 112;

function geometryFor(bins: BinView[]) {
  const rows = groupBinsInShelfOrder(bins);
  const columns = Math.max(
    3,
    ...rows.map((row) => row.bins.length),
    ...bins.map((bin) => parseBinCode(bin.code)?.slot ?? 1),
  );
  const width = SHELF_SHIFT + Math.max(980, 388 + columns * 120);
  // The left column has its own floor now: the station plus the card beneath
  // it must fit even when there are too few beds to make the scene that tall.
  const height = Math.max(
    STATION_CARD.y + STATION_CARD.height + 34,
    TOP + rows.length * PITCH + 65,
  );
  const points = new Map<string, Point>();
  rows.forEach((row, r) =>
    row.bins.forEach((bin, c) => {
      const column = (parseBinCode(bin.code)?.slot ?? c + 1) - 1;
      points.set(bin.code, {
        x: SHELF_SHIFT + 394 + column * ((width - SHELF_SHIFT - 425) / columns),
        y: TOP + r * PITCH + BIN_BASE,
      });
    }),
  );
  return { rows, width, height, points };
}
type Geometry = ReturnType<typeof geometryFor>;
function locationPoint(
  location: string | null | undefined,
  geometry: Geometry,
): Point {
  if (!location) return HOME;
  return isGantryStation(location)
    ? DOCK
    : (geometry.points.get(location) ?? HOME);
}

/** Withdraw into the clear aisle, change height, then extend into the bay.
 * No diagonal path through neighbouring totes or shelf boards. */
function travelPoint(from: Point, to: Point, progress: number): Point {
  if (from.y === to.y)
    return { x: from.x + (to.x - from.x) * progress, y: to.y };
  const stops = [from, { x: AISLE_X, y: from.y }, { x: AISLE_X, y: to.y }, to];
  const lengths = stops
    .slice(1)
    .map((p, i) => Math.abs(p.x - stops[i].x) + Math.abs(p.y - stops[i].y));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total) return to;
  let distance = progress * total;
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] && lengths[i] > 0) {
      const t = distance / lengths[i];
      return {
        x: stops[i].x + (stops[i + 1].x - stops[i].x) * t,
        y: stops[i].y + (stops[i + 1].y - stops[i].y) * t,
      };
    }
    distance -= lengths[i];
  }
  return to;
}

function itemNameLines(name: string, limit = 17): string[] {
  const words = name.trim().split(/\s+/);
  const lines = [""];
  for (const word of words) {
    const index = lines.length - 1;
    const next = `${lines[index]} ${word}`.trim();
    if (next.length <= limit) lines[index] = next;
    else if (lines.length === 1 && lines[0]) lines.push(word);
    else {
      lines[index] = `${next.slice(0, limit - 1).trimEnd()}…`;
      break;
    }
  }
  return lines.map((line) =>
    line.length > limit ? `${line.slice(0, limit - 1)}…` : line,
  );
}

function BinItemLabel({ name, quantity }: { name: string; quantity?: number }) {
  return (
    <g>
      <rect
        x="-54"
        y="13"
        width="108"
        height="34"
        rx="5"
        fill="#0b1823"
        fillOpacity=".92"
      />
      <text textAnchor="middle" fill="#d4e5ed" fontSize="10.5" fontWeight="500">
        {itemNameLines(name).map((line, index) => (
          <tspan key={index} x="0" y={27 + index * 13}>
            {line}
          </tspan>
        ))}
      </text>
      {quantity !== undefined && quantity > 0 && (
        <g>
          <rect
            x="7"
            y="-98"
            width="55"
            height="23"
            rx="7"
            fill="#c8f3fa"
            stroke="#89d9ea"
          />
          <text
            x="34.5"
            y="-82"
            textAnchor="middle"
            fill="#10313e"
            fontSize={quantity > 9999 ? 10 : 13}
            fontWeight="700"
          >
            {quantity.toLocaleString("en-US")}
            <tspan fontSize="8" fontWeight="500">
              {" "}
              pcs
            </tspan>
          </text>
        </g>
      )}
    </g>
  );
}

/** The saved photo is a visual inventory label, not an inferred item count. */
const Tote = memo(function Tote({
  code,
  quantity: providedQuantity,
  bin,
  tone = "stock",
  active = false,
}: {
  code: string;
  quantity?: number;
  bin?: BinView;
  tone?: "stock" | "empty" | "reserved";
  active?: boolean;
}) {
  const clipId = useId().replace(/:/g, "");
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const quantity = bin?.totalQuantity ?? providedQuantity;
  const item = quantity !== 0 ? bin?.contents[0] : undefined;
  const photo = item
    ? (item.catalogImageUrl ?? item.imageUrl ?? bin?.latestSnapshot?.imageUrl)
    : null;
  const name =
    item?.canonicalName ?? (quantity === 0 ? "Empty bin" : "No recorded item");
  const front =
    tone === "empty" ? "#263844" : tone === "reserved" ? "#625136" : "#23516a";
  const edge = active ? "#9aeeff" : tone === "reserved" ? "#d6ab64" : "#54849a";
  return (
    <g className="machine-tote">
      <ellipse cx="2" cy="5" rx="48" ry="9" fill="#000" opacity=".35" />
      <path
        d="M-47 -75 L-31 -92 L49 -92 L44 -75Z"
        fill="#507486"
        stroke={edge}
      />
      <path d="M-40 -74 L-28 -85 L39 -85 L35 -74Z" fill="#0b1b25" />
      <path
        d="M44 -75 L49 -92 L45 -14 L37 1Z"
        fill="#193747"
        stroke={edge}
        strokeOpacity=".5"
      />
      <path
        d="M-47 -75 L44 -75 L37 1 L-40 1Z"
        fill={front}
        stroke={edge}
        strokeWidth={active ? 1.8 : 1}
      />
      <path
        d="M-46 -72 H43 M-39 -65 L-32 -6 M37 -65 L28 -6"
        stroke="#a1d7e3"
        strokeOpacity=".15"
        strokeWidth="2"
      />
      <defs>
        <clipPath id={clipId}>
          <rect x="-34" y="-67" width="68" height="43" rx="4" />
        </clipPath>
      </defs>
      <rect
        x="-34"
        y="-67"
        width="68"
        height="43"
        rx="4"
        fill="#0c202c"
        stroke={edge}
        strokeOpacity=".4"
      />
      {photo && failedImage !== photo ? (
        <image
          href={photo}
          x="-34"
          y="-67"
          width="68"
          height="43"
          preserveAspectRatio="xMidYMid meet"
          clipPath={`url(#${clipId})`}
          onError={() => setFailedImage(photo)}
        />
      ) : (
        <g fill="none" stroke="#678b9d" strokeWidth="1.3">
          <path d="M-10 -55 L0 -60 L10 -55 L10 -43 L0 -38 L-10 -43Z M-10 -55 L0 -50 L10 -55 M0 -50 V-38" />
          <text
            x="0"
            y="-28"
            textAnchor="middle"
            stroke="none"
            fill="#8da9b8"
            fontSize="7"
          >
            {quantity === 0 ? "EMPTY" : "NO PHOTO"}
          </text>
        </g>
      )}
      <rect x="-28" y="-20" width="55" height="17" rx="3" fill="#e0e7df" />
      <text
        x="0"
        y="-8"
        textAnchor="middle"
        fill="#17252d"
        fontSize="11"
        fontWeight="700"
      >
        {code}
      </text>
      <BinItemLabel name={name} quantity={quantity} />
    </g>
  );
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
  const reducedRef = useRef(reduced);
  const keyRef = useRef("");
  const queue = useRef<GantryStatus[]>([]);
  const frame = useRef<number | null>(null);
  const work = useRef<{
    gantry: GantryStatus;
    from: Point;
    to: Point;
    started: number;
    duration: number;
  } | null>(null);

  useEffect(() => {
    geometryRef.current = geometry;
  }, [geometry]);
  useEffect(() => {
    reducedRef.current = reduced;
  }, [reduced]);

  useEffect(() => {
    if (!input) return;
    const key = [
      input.activeOperationId,
      input.operation?.operationId,
      input.state,
      input.motion?.startedAt,
      input.currentLocation,
      input.lastError,
    ].join("|");
    if (key === keyRef.current) return;
    keyRef.current = key;
    if (
      input.state === "OFFLINE" ||
      input.state === "ERROR" ||
      (input.state === "IDLE" && input.lastError)
    ) {
      queue.current = [];
      work.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      setView({ gantry: input, point: shown.current });
      return;
    }

    // A completed home reading is the controller's authoritative final pose.
    // Drop stale shelf frames that may still be queued after a slow render and
    // smoothly finish from the currently displayed point instead.
    const settledAtHome =
      input.state === "IDLE" &&
      input.currentLocation === null &&
      input.activeOperationId === null;
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
        if (!status) {
          frame.current = null;
          return;
        }
        const to = locationPoint(
          status.motion ? status.motion.to : status.currentLocation,
          geometryRef.current,
        );
        const finalHome =
          status.state === "IDLE" &&
          status.currentLocation === null &&
          status.activeOperationId === null;
        const remaining = status.motion
          ? status.motion.durationMs - status.motion.elapsedMs
          : finalHome
            ? 650
            : 220;
        work.current = {
          gantry: status,
          from: shown.current,
          to,
          started: now,
          duration: Math.max(
            status.state === "MOVING" || status.state === "HOMING" ? 350 : 120,
            remaining,
          ),
        };
      }
      const step = work.current;
      const progress = reducedRef.current
        ? 1
        : Math.min(1, (now - step.started) / step.duration);
      const eased = progress * progress * (3 - 2 * progress);
      const moving =
        step.gantry.state === "MOVING" || step.gantry.state === "HOMING";
      const point = moving
        ? travelPoint(step.from, step.to, eased)
        : {
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
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return view;
}

function Carriage({
  arm,
  point,
  bin,
}: {
  arm: RackArmState;
  point: Point;
  bin?: BinView;
}) {
  const handling = arm.phase === "PICKING" || arm.phase === "DROPPING";
  return (
    <g aria-hidden="true">
      <g transform={`translate(0 ${point.y})`}>
        <rect
          x={AISLE_X - 15}
          y="-34"
          width="30"
          height="52"
          rx="5"
          fill="#60717d"
          stroke="#a2bac9"
        />
        <rect
          x={AISLE_X - 10}
          y="-25"
          width="20"
          height="32"
          rx="3"
          fill="#182a38"
        />
        <circle
          cx={AISLE_X}
          cy="-10"
          r="5"
          fill={arm.phase === "FAULT" ? "#fb7185" : "#83e1f6"}
        />
        <path
          d={`M${AISLE_X} 4 H${point.x}`}
          stroke="#111e29"
          strokeWidth="15"
          strokeLinecap="round"
        />
        <path
          d={`M${AISLE_X} 0 H${point.x}`}
          stroke="#778c9b"
          strokeWidth="5"
        />
      </g>
      <g transform={`translate(${point.x} ${point.y})`}>
        {arm.carrying && <Tote code={arm.focusBin ?? "BIN"} bin={bin} active />}
        <g className={handling ? "machine-grip" : ""}>
          <path
            d="M-49 -8 V8 H49 V-8"
            fill="none"
            stroke="#b6cbd7"
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <path
            d="M-49 -8 V-22 M49 -8 V-22"
            stroke="#76e4f4"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </g>
        <rect x="-32" y="9" width="64" height="7" rx="3" fill="#314b5b" />
      </g>
    </g>
  );
}

const Structure = memo(function Structure({
  geometry,
  id,
}: {
  geometry: Geometry;
  id: string;
}) {
  // Shelf-local: the group below is translated, so `right` is measured from
  // the shelf's own origin rather than from the canvas edge.
  const right = geometry.width - 45 - SHELF_SHIFT;
  const bottom = TOP + geometry.rows.length * PITCH;
  return (
    <g aria-hidden="true" transform={`translate(${SHELF_SHIFT} 0)`}>
      {/* Back uprights, diagonal bracing and recessed bays create real shelf depth. */}
      <path
        d={`M371 81 L${right + 18} ${bottom - 20} M${right + 18} 81 L371 ${bottom - 20}`}
        stroke="#2e414d"
        strokeWidth="4"
        opacity=".45"
      />
      {[365, right + 17].map((x) => (
        <rect
          key={x}
          x={x}
          y="79"
          width="12"
          height={bottom - 65}
          fill="#253743"
        />
      ))}
      {geometry.rows.map((row, index) => {
        const y = TOP + index * PITCH + BIN_BASE + 12;
        return (
          <g key={row.bed ?? "other"}>
            <path
              d={`M337 ${y} L367 ${y - 24} H${right + 28} L${right} ${y}Z`}
              fill={`url(#${id}-shelf)`}
              stroke="#506675"
            />
            <rect
              x="337"
              y={y}
              width={right - 337}
              height="13"
              rx="2"
              fill="#233442"
              stroke="#4b606e"
            />
            <path
              d={`M344 ${y + 2} H${right - 5}`}
              stroke="#b1c7d4"
              strokeOpacity=".25"
            />
            <rect
              x="342"
              y={y + 3}
              width="38"
              height="8"
              rx="2"
              fill="#111e2a"
            />
            <text
              x="360"
              y={y + 10}
              fill="#8aa5b7"
              textAnchor="middle"
              fontSize="7"
            >
              BED {row.bed ?? "—"}
            </text>
          </g>
        );
      })}
      {[330, right].map((x) => (
        <g key={x}>
          <path
            d={`M${x} 97 L${x + 13} 85 L${x + 13} ${bottom + 18} L${x} ${bottom + 30}Z`}
            fill="#465a68"
          />
          <rect
            x={x - 9}
            y="97"
            width="13"
            height={bottom - 67}
            rx="2"
            fill={`url(#${id}-steel)`}
            stroke="#617483"
            strokeWidth=".7"
          />
          {Array.from({ length: Math.floor((bottom - 100) / 17) }, (_, i) => (
            <rect
              key={i}
              x={x - 5}
              y={112 + i * 17}
              width="4"
              height="7"
              rx="1.5"
              fill="#07111a"
            />
          ))}
          <path
            d={`M${x - 17} ${bottom + 31} H${x + 17} L${x + 25} ${bottom + 23} H${x - 9}Z`}
            fill="#506370"
          />
        </g>
      ))}
      <path
        d={`M323 99 L354 76 H${right + 28} L${right + 2} 99Z`}
        fill="#3a5262"
        stroke="#637c8d"
      />
      <rect
        x="323"
        y="98"
        width={right - 321}
        height="13"
        rx="2"
        fill="#213542"
        stroke="#4c6576"
      />
      <text x="345" y="64" fill="#7c99ac" fontSize="10" letterSpacing="3">
        STORAGE ARRAY
      </text>
      {/* Lead screw and guide rails, independent of the shelf frame. */}
      <rect
        x="262"
        y="85"
        width="32"
        height={bottom - 50}
        rx="8"
        fill="#0d1b27"
        stroke="#354e61"
      />
      <path
        d={`M266 98 V${bottom + 23} M290 98 V${bottom + 23}`}
        stroke="#7b94a5"
        strokeWidth="3"
      />
      <rect
        x="276"
        y="99"
        width="4"
        height={bottom - 78}
        fill={`url(#${id}-screw)`}
      />
      <rect
        x="262"
        y={bottom + 28}
        width="33"
        height="27"
        rx="4"
        fill="#304958"
        stroke="#617b8d"
      />
      <circle cx="278" cy={bottom + 41} r="7" fill="#112532" stroke="#89a5b5" />
    </g>
  );
});

function CameraRig({
  scanning,
  dockBin,
  scanImage,
  connection,
  temperature,
}: {
  scanning: boolean;
  dockBin?: BinView;
  scanImage?: string;
  connection: "ONLINE" | "DEGRADED" | "OFFLINE";
  temperature: number | null;
}) {
  const cameraColor =
    connection === "ONLINE"
      ? "#6ee7b7"
      : connection === "DEGRADED"
        ? "#f4c078"
        : "#fb7185";
  return (
    <g aria-hidden="true">
      <rect
        x="31"
        y="39"
        width="214"
        height="350"
        rx="13"
        fill="#071824"
        fillOpacity=".44"
        stroke="#34566a"
        strokeWidth="1.5"
      />
      <text
        x="48"
        y="66"
        fill="#9adff1"
        fontSize="13"
        fontWeight="700"
        letterSpacing="2"
      >
        CHECKOUT STATION
      </text>
      <text x="48" y="82" fill="#7697aa" fontSize="8" letterSpacing="1.7">
        VISION / VERIFICATION
      </text>
      <path
        d="M62 284 V92 H148 V116"
        fill="none"
        stroke="#152835"
        strokeWidth="14"
        strokeLinejoin="round"
      />
      <path d="M59 280 V90 H146" fill="none" stroke="#587183" strokeWidth="3" />
      {/* Raspberry Pi enclosure, side ports and a downward-facing lens. */}
      <path
        d="M117 104 L131 94 H184 L170 104Z"
        fill="#546b7a"
        stroke="#7694a5"
      />
      <path
        d="M170 104 L184 94 V124 L170 135Z"
        fill="#213b4b"
        stroke="#486574"
      />
      <rect
        x="115"
        y="104"
        width="56"
        height="31"
        rx="5"
        fill="#364e5f"
        stroke="#8aa8b9"
      />
      <rect
        x="122"
        y="111"
        width="20"
        height="14"
        rx="2"
        fill="#214634"
        stroke="#588369"
      />
      <rect x="127" y="113" width="8" height="8" rx="1" fill="#142b24" />
      <path
        d="M149 111 V126 M154 111 V126 M159 111 V126"
        stroke="#152a38"
        strokeWidth="2"
      />
      <circle cx="165" cy="109" r="2" fill={cameraColor} />
      <path
        d="M137 136 L143 143 H162 L168 136"
        fill="#122d3d"
        stroke="#68889b"
      />
      <ellipse
        cx="152"
        cy="143"
        rx="10"
        ry="4"
        fill="#092536"
        stroke="#79d9ed"
      />
      <ellipse
        cx="152"
        cy="143"
        rx="5"
        ry="2"
        fill={scanning ? "#a5f3fc" : "#3b859c"}
      />
      <g transform="translate(0 30)">
        <path
          d="M83 235 L108 216 H228 L204 235Z"
          fill="#436171"
          stroke="#789baa"
        />
        <path d="M83 235 H204 V244 H83Z" fill="#263f50" stroke="#567182" />
        <path d="M204 235 L228 216 V225 L204 244Z" fill="#1c3342" />
        <path d="M94 245 V263 M194 245 V263" stroke="#516977" strokeWidth="9" />
        {dockBin ? (
          <g transform="translate(155 225)">
            <Tote code={dockBin.code} bin={dockBin} active={scanning} />
          </g>
        ) : (
          <path
            d="M121 226 H182 M152 219 V232"
            stroke="#87a9ba"
            strokeOpacity=".5"
          />
        )}
        <rect
          x="83"
          y="308"
          width="145"
          height="56"
          rx="8"
          fill="#0b1d2a"
          stroke={scanning ? "#5299ae" : "#294353"}
        />
        <circle
          cx="98"
          cy="326"
          r="3"
          fill={scanning ? "#67e8f9" : dockBin ? "#f4c078" : "#6a879a"}
        />
        <text x="109" y="330" fill="#c2d8e4" fontSize="10">
          {scanning ? "ANALYZING FRAME" : `PI ${connection}`}
        </text>
        <text x="98" y="348" fill="#7e9aaf" fontSize="9">
          {dockBin?.code ??
            (temperature == null
              ? "Temperature —"
              : `${temperature.toFixed(1)}°C · camera ready`)}
        </text>
      </g>
      {scanning && (
        <g>
          {scanImage && (
            <g>
              <rect
                x="103"
                y="174"
                width="104"
                height="74"
                rx="5"
                fill="#09232d"
                stroke="#74d5e8"
              />
              <image
                href={scanImage}
                x="106"
                y="177"
                width="98"
                height="68"
                preserveAspectRatio="xMidYMid meet"
              />
            </g>
          )}
          <g className="machine-scan-cone">
            <path
              d="M144 147 L102 251 H207 L159 147Z"
              fill="#5ce1f4"
              fillOpacity=".09"
            />
            <path
              d="M144 147 L102 251 M159 147 L207 251"
              stroke="#67e8f9"
              strokeOpacity=".5"
              strokeDasharray="4 5"
            />
            <ellipse
              className="machine-scan-ring"
              cx="155"
              cy="243"
              rx="49"
              ry="10"
              fill="none"
              stroke="#8dedf8"
              strokeWidth="2"
            />
          </g>
        </g>
      )}
    </g>
  );
}

const STATION_STATUS_COLOR: Record<string, string> = {
  CHECKED_OUT: "#f4c078",
  OCCUPIED: "#9adff1",
  RESERVED: "#d6ab64",
  AVAILABLE: "#90a6b6",
  DISABLED: "#fb7185",
};

/**
 * WHAT IS ON THE DOCK RIGHT NOW, in words.
 *
 * The station's own readout is a one-line status strip with room for a bin
 * code and nothing else, so the tote sitting at the dock had no part name, no
 * SKU and no count anywhere in the scene — the operator had to go and find the
 * bin on the shelf, which is exactly where it is not.
 *
 * It sits directly beneath the station rather than beside it because the left
 * column is only as wide as the shelf frame allows (the outer post starts at
 * x=321). A card narrow enough to fit alongside would be a few dozen pixels
 * across once the scene is scaled into its panel, which is no card at all.
 * Below the station the width is free and the space is otherwise unused.
 *
 * Reads only from the bin the scene already resolved to the dock. It never
 * fetches, and it never states a count the overview did not report.
 */
function StationBinCard({
  bin,
  scanning,
  onSelect,
}: {
  bin?: BinView;
  scanning: boolean;
  onSelect?: (bin: BinView) => void;
}) {
  const clipId = useId().replace(/:/g, "");
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const { width: w, height: h } = CARD_ART;
  const item = bin?.contents[0];
  const photo =
    item?.catalogImageUrl ??
    item?.imageUrl ??
    bin?.latestSnapshot?.imageUrl ??
    null;
  const statusColor = bin
    ? (STATION_STATUS_COLOR[bin.status] ?? "#90a6b6")
    : "#5c7787";
  const interactive = !!bin && !!onSelect;
  const verifiedQuantity =
    bin?.latestSnapshot?.measuredQuantity ?? bin?.totalQuantity ?? 0;
  const weightStable =
    bin?.latestSnapshot?.weightSource === "SCALE" &&
    bin.latestSnapshot.totalWeightGrams != null;
  const hasEstimatedWeight = bin?.latestSnapshot?.weightSource === "FALLBACK";
  const visionClear = (bin?.latestSnapshot?.confidencePercent ?? 0) > 80;

  return (
    <g
      transform={`translate(${STATION_CARD.x} ${STATION_CARD.y}) scale(${CARD_SCALE})`}
      className={interactive ? "cursor-pointer outline-none" : undefined}
      role={interactive ? "button" : "group"}
      tabIndex={interactive ? 0 : undefined}
      aria-label={
        bin
          ? `At the checkout station: bin ${bin.code}, ${item?.canonicalName ?? "no recorded contents"}, ${bin.totalQuantity} on record. View bin.`
          : "Checkout station is clear. No bin is docked."
      }
      onClick={() => bin && onSelect?.(bin)}
      onKeyDown={(event) => {
        if (!bin || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect?.(bin);
      }}
    >
      {bin && (
        <title>{`${bin.code} · ${bin.status} · ${item?.canonicalName ?? "No recorded contents"}`}</title>
      )}
      <rect
        width={w}
        height={h}
        rx="12"
        fill="#071824"
        fillOpacity=".92"
        stroke={bin ? "#41748c" : "#28414f"}
        strokeWidth="1.5"
      />
      <path d={`M0 31 H${w}`} stroke="#223d4b" />
      <circle
        cx="19"
        cy="16"
        r="4.5"
        fill={scanning ? "#67e8f9" : bin ? statusColor : "#425a68"}
      />
      <text x="33" y="20" fill="#9adff1" fontSize="10" letterSpacing="1.6">
        {scanning ? "VERIFYING AT STATION" : "AT CHECKOUT STATION"}
      </text>
      {bin ? (
        <g>
          <text
            x={w - 14}
            y="20"
            textAnchor="end"
            fill="#c8f3fa"
            fontSize="11"
            fontWeight="700"
          >
            {bin.code}
          </text>
          <defs>
            <clipPath id={clipId}>
              <rect x="14" y="44" width="96" height="70" rx="6" />
            </clipPath>
          </defs>
          <rect
            x="14"
            y="44"
            width="96"
            height="70"
            rx="6"
            fill="#0c202c"
            stroke="#3d6274"
            strokeOpacity=".8"
          />
          {photo && failedImage !== photo ? (
            <image
              href={photo}
              x="14"
              y="44"
              width="96"
              height="70"
              preserveAspectRatio="xMidYMid meet"
              clipPath={`url(#${clipId})`}
              onError={() => setFailedImage(photo)}
            />
          ) : (
            <g fill="none" stroke="#5c8496" strokeWidth="1.3">
              <path d="M44 92 L58 72 L70 88 L77 80 L88 92Z" />
              <circle cx="76" cy="63" r="5" />
            </g>
          )}
          <text x="124" y="70" fill="#e6f2f8" fontSize="27" fontWeight="700">
            {verifiedQuantity.toLocaleString("en-US")}
            <tspan
              dx="6"
              fontSize="10"
              fontWeight="600"
              fill="#9adff1"
              letterSpacing="1.2"
            >
              VERIFIED
            </tspan>
          </text>
          <text
            x="124"
            y="94"
            fill={weightStable ? "#7de2b8" : "#d6ab64"}
            fontSize="10"
            letterSpacing=".8"
          >
            {weightStable
              ? "WEIGHT STABLE ✓"
              : hasEstimatedWeight
                ? "WEIGHT ESTIMATED"
                : "WEIGHT PENDING"}
          </text>
          <text
            x="124"
            y="113"
            fill={visionClear ? "#7de2b8" : "#d6ab64"}
            fontSize="10"
            letterSpacing=".8"
          >
            {visionClear ? "VISION CLEAR ✓" : "VISION REVIEW"}
          </text>
          <path d={`M14 128 H${w - 14}`} stroke="#1d3543" />
          <text x="14" fill="#c2d8e4" fontSize="12.5">
            {itemNameLines(
              item?.canonicalName ?? "No recorded contents",
              34,
            ).map((line, index) => (
              <tspan key={index} x="14" y={148 + index * 16}>
                {line}
              </tspan>
            ))}
          </text>
        </g>
      ) : (
        <g>
          <rect
            x="14"
            y="46"
            width={w - 28}
            height={h - 62}
            rx="8"
            fill="none"
            stroke="#2b4655"
            strokeDasharray="5 6"
          />
          <text
            x={w / 2}
            y="98"
            textAnchor="middle"
            fill="#8ba7b8"
            fontSize="12"
          >
            Station clear
          </text>
          <text
            x={w / 2}
            y="118"
            textAnchor="middle"
            fill="#5f7c8d"
            fontSize="9.5"
          >
            A retrieved bin appears here
          </text>
        </g>
      )}
    </g>
  );
}

function WarehouseActionsMenu({ onManageBins }: { onManageBins?: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="Warehouse actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="grid size-10 place-items-center rounded-lg border border-line bg-bg-elevated text-ink-muted transition-colors hover:border-accent-soft hover:bg-accent-tint hover:text-accent"
      >
        <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
          <path
            d="M4 5.5h12M4 10h12M4 14.5h12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Warehouse actions"
          className="absolute right-0 top-12 z-20 w-52 rounded-xl border border-line bg-surface p-1.5 shadow-2xl shadow-black/50"
        >
          <CaptureStation menuItem onDialogClosed={() => setOpen(false)} />
          {onManageBins && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onManageBins();
              }}
              className="flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm font-medium text-ink transition-colors hover:bg-accent-tint hover:text-accent"
            >
              Manage bins
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A code-native, perspective machine scene. Only telemetry drives movement;
 * the database still owns stock, capacity and availability. */
export function WarehouseRack({
  bins,
  loading,
  error,
  onRetry,
  gantry: rawGantry,
  activeMovement,
  latestAudit,
  onManageBins,
  onSelectBin,
}: {
  bins: BinView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  gantry: GantryStatus | null;
  activeMovement: MovementRowView | null;
  latestAudit: InventoryAuditView | null;
  onManageBins?: () => void;
  onSelectBin?: (bin: BinView) => void;
}) {
  const id = useId().replace(/:/g, "");
  const geometry = useMemo(() => geometryFor(bins), [bins]);
  const { gantry, point } = useGantryPlayback(rawGantry, geometry);
  const arm = deriveRackArmState({ gantry, activeMovement, latestAudit });
  const audit = useAuditCapture();
  const session = useWarehouseSession();
  const { health: cameraHealth } = useCameraHealth();
  const workflowCameraActive = ["CLAIMED", "UPLOADED", "PROCESSING"].includes(
    audit.cameraJob?.status ?? "",
  );
  const scanning = session.scanning || audit.submitting || workflowCameraActive;
  const operation = gantry?.operation;
  const currentAtStation =
    !!gantry?.currentLocation && isGantryStation(gantry.currentLocation);
  const checkedOut = bins.filter((bin) => bin.status === "CHECKED_OUT");
  const activeBin = bins.find((bin) => bin.code === arm.focusBin);
  const isReturn =
    operation?.destination && !isGantryStation(operation.destination);
  const returned =
    operation?.status === "COMPLETED" && isReturn
      ? operation.destination
      : null;
  const dockBin =
    !arm.carrying &&
    currentAtStation &&
    operation?.status !== "FAILED" &&
    (operation?.status === "COMPLETED" ||
      (operation?.source && isGantryStation(operation.source)))
      ? (activeBin ?? checkedOut.find((bin) => bin.code !== returned))
      : !gantry?.activeOperationId && !arm.carrying
        ? checkedOut.find((bin) => bin.code !== returned)
        : null;
  const presented = dockBin?.code ?? null;
  const highlightedBinCode = arm.focusBin ?? dockBin?.code ?? null;
  const rackFocusActive =
    highlightedBinCode !== null &&
    (!!gantry?.activeOperationId || dockBin !== null);

  return (
    <section
      className="machine-panel flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-line"
      aria-label="RackHand live rack"
    >
      <div className="machine-toolbar flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="font-mono text-[10px] tracking-[.22em] text-accent">
            RACKHAND / LIVE RACK
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <WarehouseActionsMenu onManageBins={onManageBins} />
          <AuditCaptureModeToggle />
        </div>
      </div>
      {error && (
        <div className="px-5 pb-3">
          <ErrorNote onRetry={onRetry}>{error}</ErrorNote>
        </div>
      )}
      {loading && bins.length === 0 ? (
        <div
          className="flex h-80 items-center justify-center text-sm text-ink-muted"
          role="status"
        >
          Loading the rack…
        </div>
      ) : bins.length === 0 ? (
        <div className="p-12 text-center text-sm text-ink-muted">
          No bins yet. Add bins to build your storage rack.
        </div>
      ) : (
        <div className="machine-scene min-h-0 flex-1 overflow-hidden">
          <svg
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            className="machine-scene-svg block w-full font-mono"
            preserveAspectRatio="xMidYMid meet"
            role="group"
            aria-label="Interactive storage rack. Select a bin to inspect its contents."
          >
            <defs>
              <linearGradient id={`${id}-steel`} x2="1" y2="0">
                <stop stopColor="#162c3a" />
                <stop offset=".45" stopColor="#526979" />
                <stop offset="1" stopColor="#203646" />
              </linearGradient>
              <linearGradient id={`${id}-shelf`} x2=".2" y2="1">
                <stop stopColor="#142634" />
                <stop offset="1" stopColor="#4c626f" />
              </linearGradient>
              <pattern
                id={`${id}-screw`}
                width="4"
                height="7"
                patternUnits="userSpaceOnUse"
              >
                <rect width="4" height="7" fill="#6d8596" />
                <path d="M0 6 L4 2" stroke="#1c3344" strokeWidth="2" />
              </pattern>
              <pattern
                id={`${id}-floor`}
                width="48"
                height="24"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M0 24 L24 0 L48 24 M0 0 H48"
                  fill="none"
                  stroke="#557e96"
                  strokeOpacity=".1"
                />
              </pattern>
              <radialGradient id={`${id}-light`}>
                <stop stopColor="#24718e" stopOpacity=".18" />
                <stop offset="1" stopColor="#112431" stopOpacity="0" />
              </radialGradient>
              <filter
                id={`${id}-active-glow`}
                x="-40%"
                y="-40%"
                width="180%"
                height="180%"
              >
                <feGaussianBlur stdDeviation="4" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <rect
              width={geometry.width}
              height={geometry.height}
              fill={`url(#${id}-light)`}
            />
            <path
              d={`M25 ${geometry.height - 115} L${geometry.width - 120} ${geometry.height - 175} L${geometry.width} ${geometry.height} H0Z`}
              fill={`url(#${id}-floor)`}
            />
            <ellipse
              cx={geometry.width * 0.61}
              cy={geometry.height - 38}
              rx={geometry.width * 0.33}
              ry="23"
              fill="#020911"
              opacity=".6"
            />
            <Structure geometry={geometry} id={id} />
            {geometry.rows.flatMap((row) =>
              row.bins.map((bin) => {
                const point = geometry.points.get(bin.code)!;
                const approachingPickup =
                  !!gantry?.activeOperationId &&
                  operation?.source === bin.code &&
                  !arm.carrying;
                const highlighted = bin.code === highlightedBinCode;
                const absent =
                  (!approachingPickup &&
                    bin.status === "CHECKED_OUT" &&
                    bin.code !== returned) ||
                  bin.code === presented ||
                  (arm.carrying && bin.code === arm.focusBin);
                return (
                  <g
                    key={bin.binId}
                    transform={`translate(${point.x} ${point.y})`}
                    className="machine-bin cursor-pointer outline-none"
                    role="button"
                    tabIndex={onSelectBin ? 0 : undefined}
                    style={{
                      opacity: rackFocusActive && !highlighted ? 0.2 : 1,
                      transition: "opacity 240ms ease",
                    }}
                    aria-label={`${bin.code}, ${bin.contents[0]?.canonicalName ?? "Empty bin"}, ${bin.status.replaceAll("_", " ").toLowerCase()}, ${bin.totalQuantity} on record. View bin.`}
                    onClick={() => onSelectBin?.(bin)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectBin?.(bin);
                      }
                    }}
                  >
                    <title>{`${bin.code} · ${bin.status} · ${bin.contents[0]?.canonicalName ?? "No recorded contents"}`}</title>
                    <rect
                      className="machine-bin-focus"
                      x="-55"
                      y="-103"
                      width="119"
                      height="155"
                      rx="9"
                      fill={
                        highlighted && rackFocusActive
                          ? "#67e8f912"
                          : "transparent"
                      }
                      stroke={
                        highlighted && rackFocusActive
                          ? "#9aeeff"
                          : "transparent"
                      }
                      strokeWidth={highlighted && rackFocusActive ? 4 : 1}
                      filter={
                        highlighted && rackFocusActive
                          ? `url(#${id}-active-glow)`
                          : undefined
                      }
                    />
                    {absent ? (
                      <g>
                        <path
                          d="M-44 -43 L40 -43 L35 1 H-38Z"
                          fill="#142532"
                          fillOpacity=".3"
                          stroke="#607583"
                          strokeDasharray="4 5"
                        />
                        <text
                          x="0"
                          y="-19"
                          textAnchor="middle"
                          fill="#9fb3c2"
                          fontSize="11"
                        >
                          {bin.code}
                        </text>
                        <text
                          x="0"
                          y="-3"
                          textAnchor="middle"
                          fill="#d2b280"
                          fontSize="9"
                        >
                          {bin.status === "CHECKED_OUT"
                            ? "CHECKED OUT"
                            : "IN TRANSIT"}
                        </text>
                        <BinItemLabel
                          name={bin.contents[0]?.canonicalName ?? "Empty bin"}
                          quantity={bin.totalQuantity}
                        />
                      </g>
                    ) : (
                      <Tote
                        code={bin.code}
                        bin={bin}
                        tone={
                          bin.status === "AVAILABLE"
                            ? "empty"
                            : bin.status === "OCCUPIED"
                              ? "stock"
                              : "reserved"
                        }
                        active={highlighted && rackFocusActive}
                      />
                    )}
                  </g>
                );
              }),
            )}
            <g
              className="machine-checkout"
              transform={`translate(${CHECKOUT_OFFSET.x} ${CHECKOUT_OFFSET.y}) scale(${CHECKOUT_SCALE})`}
            >
              <CameraRig
                scanning={scanning}
                dockBin={dockBin ?? undefined}
                scanImage={
                  session.scanning ? session.shots[0]?.dataUrl : undefined
                }
                connection={cameraHealth?.connection ?? "OFFLINE"}
                temperature={cameraHealth?.cpuTemperatureC ?? null}
              />
            </g>
            <StationBinCard
              bin={dockBin ?? undefined}
              scanning={scanning}
              onSelect={onSelectBin}
            />
            <Carriage arm={arm} point={point} bin={activeBin} />
          </svg>
        </div>
      )}
      <div className="machine-status flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3">
        <p
          className="flex items-center gap-2 text-xs text-ink-muted"
          role="status"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${arm.phase === "FAULT" ? "bg-danger" : "bg-accent"}`}
          />
          {scanning ? "Analyzing captured frame · camera station" : arm.label}
        </p>
        <div className="flex gap-3 font-mono text-[9px] text-ink-faint">
          <span>{bins.length} SLOTS</span>
          <span>{checkedOut.length} CHECKED OUT</span>
          <span>PI {cameraHealth?.connection ?? "OFFLINE"}</span>
          {cameraHealth?.cpuTemperatureC != null && (
            <span>{cameraHealth.cpuTemperatureC.toFixed(1)}°C</span>
          )}
        </div>
      </div>
      {checkedOut.length > 0 && (
        <p className="machine-checkout-note shrink-0 border-t border-line px-5 py-3 text-xs text-ink-muted">
          Checked out: {checkedOut.map((bin) => bin.code).join(", ")}. Stock
          remains recorded; putaway returns the bin to its shelf.
        </p>
      )}
      <div className="shrink-0 px-4 pb-3 empty:hidden">
        <ScanResultDialog />
      </div>
    </section>
  );
}

import "server-only";

import { prisma } from "@/lib/warehouse/db";
import type {
  CameraDeviceConnection,
  CameraDeviceHealthView,
  CameraWorkerState,
} from "./device-health-types";

const WORKER_STATES = [
  "STARTING",
  "READY",
  "CAPTURING",
  "UPLOADING",
  "DEGRADED",
  "STOPPING",
] as const;
const ONLINE_AFTER_MS = 30_000;
const OFFLINE_AFTER_MS = 90_000;

export interface CameraDeviceHeartbeatInput {
  workerState: Exclude<CameraWorkerState, "UNKNOWN">;
  cameraReady: boolean;
  previewReady: boolean;
  activeJobId: string | null;
  cpuTemperatureC: number | null;
  cpuLoadPercent: number | null;
  memoryUsedPercent: number | null;
  workerVersion: string | null;
  workerStartedAt: Date | null;
  lastError: string | null;
}

export function configuredCameraDeviceId(): string {
  return process.env.CAMERA_DEVICE_ID?.trim() || "warehouse-camera-01";
}

function boundedMetric(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Camera health metric must be a finite number or null.");
  }
  if (value < minimum || value > maximum) {
    throw new Error("Camera health metric is outside its valid range.");
  }
  return Math.round(value * 10) / 10;
}

function nullableText(value: unknown, maximumLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("Camera health text must be a string or null.");
  }
  return value.trim().slice(0, maximumLength) || null;
}

export function parseCameraDeviceHeartbeat(body: unknown): CameraDeviceHeartbeatInput {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!WORKER_STATES.includes(input.workerState as (typeof WORKER_STATES)[number])) {
    throw new Error("Camera workerState is invalid.");
  }
  if (typeof input.cameraReady !== "boolean" || typeof input.previewReady !== "boolean") {
    throw new Error("Camera readiness fields must be boolean.");
  }
  let workerStartedAt: Date | null = null;
  if (input.workerStartedAt !== null && input.workerStartedAt !== undefined) {
    if (typeof input.workerStartedAt !== "string") {
      throw new Error("workerStartedAt is invalid.");
    }
    workerStartedAt = new Date(input.workerStartedAt);
    if (!Number.isFinite(workerStartedAt.getTime())) {
      throw new Error("workerStartedAt is invalid.");
    }
  }
  return {
    workerState: input.workerState as CameraDeviceHeartbeatInput["workerState"],
    cameraReady: input.cameraReady,
    previewReady: input.previewReady,
    activeJobId: nullableText(input.activeJobId, 128),
    cpuTemperatureC: boundedMetric(input.cpuTemperatureC, -40, 150),
    cpuLoadPercent: boundedMetric(input.cpuLoadPercent, 0, 100),
    memoryUsedPercent: boundedMetric(input.memoryUsedPercent, 0, 100),
    workerVersion: nullableText(input.workerVersion, 64),
    workerStartedAt,
    lastError: nullableText(input.lastError, 500),
  };
}

export async function recordCameraDeviceHeartbeat(
  deviceId: string,
  input: CameraDeviceHeartbeatInput,
) {
  const now = new Date();
  const data = { ...input, lastSeenAt: now, updatedAt: now };
  return prisma.cameraDeviceHealth.upsert({
    where: { deviceId },
    create: { deviceId, ...data },
    update: data,
  });
}

function connectionFor(
  lastSeenAt: Date,
  workerState: string,
  cameraReady: boolean,
  now: Date,
): CameraDeviceConnection {
  const age = now.getTime() - lastSeenAt.getTime();
  if (age > OFFLINE_AFTER_MS) return "OFFLINE";
  if (age > ONLINE_AFTER_MS || workerState === "DEGRADED" || !cameraReady) {
    return "DEGRADED";
  }
  return "ONLINE";
}

export async function getCameraDeviceHealth(
  deviceId = configuredCameraDeviceId(),
  now = new Date(),
): Promise<CameraDeviceHealthView> {
  const health = await prisma.cameraDeviceHealth.findUnique({ where: { deviceId } });
  if (!health) {
    return {
      deviceId,
      connection: "OFFLINE",
      workerState: "UNKNOWN",
      cameraReady: false,
      previewReady: false,
      activeJobId: null,
      cpuTemperatureC: null,
      cpuLoadPercent: null,
      memoryUsedPercent: null,
      workerVersion: null,
      workerStartedAt: null,
      lastError: null,
      lastSeenAt: null,
    };
  }
  return {
    deviceId: health.deviceId,
    connection: connectionFor(health.lastSeenAt, health.workerState, health.cameraReady, now),
    workerState: health.workerState as CameraWorkerState,
    cameraReady: health.cameraReady,
    previewReady: health.previewReady,
    activeJobId: health.activeJobId,
    cpuTemperatureC: health.cpuTemperatureC,
    cpuLoadPercent: health.cpuLoadPercent,
    memoryUsedPercent: health.memoryUsedPercent,
    workerVersion: health.workerVersion,
    workerStartedAt: health.workerStartedAt?.toISOString() ?? null,
    lastError: health.lastError,
    lastSeenAt: health.lastSeenAt.toISOString(),
  };
}

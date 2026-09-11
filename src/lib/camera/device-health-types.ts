export type CameraDeviceConnection = "ONLINE" | "DEGRADED" | "OFFLINE";

export type CameraWorkerState =
  | "STARTING"
  | "READY"
  | "CAPTURING"
  | "UPLOADING"
  | "DEGRADED"
  | "STOPPING"
  | "UNKNOWN";

export interface CameraDeviceHealthView {
  deviceId: string;
  connection: CameraDeviceConnection;
  workerState: CameraWorkerState;
  cameraReady: boolean;
  previewReady: boolean;
  activeJobId: string | null;
  cpuTemperatureC: number | null;
  cpuLoadPercent: number | null;
  memoryUsedPercent: number | null;
  workerVersion: string | null;
  workerStartedAt: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
}

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditCaptureProvider } from "@/components/warehouse/audit-capture-dialog";
import { CameraHealthProvider } from "@/components/warehouse/camera-health-provider";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {}

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AuditCaptureProvider", () => {
  function emitReadyComparison(captures: FakeEventSource) {
    captures.emit("pending", {
      captureId: "capture-1",
      binCode: "B5-03",
      purpose: "PUTAWAY",
      captureMode: "PROD",
      analysis: {
        captureMode: "PROD",
        captureId: "capture-1",
        binCode: "B5-03",
        status: "READY",
        outcome: "READY",
        expectedQuantity: 5,
        observedQuantity: 5,
        confidencePercent: 100,
        totalWeightGrams: 150,
        tareWeightGrams: 117,
        netWeightGrams: 33,
        unitWeightGrams: 6.6,
        weightSource: "FALLBACK",
        previousImageUrl: null,
        currentImageUrl: null,
        foreignObjects: [],
        notes: "Five parts are visible.",
      },
    });
  }

  it("closes a stale comparison when the server reports no pending capture", async () => {
    render(
      <CameraHealthProvider>
        <AuditCaptureProvider>
          <div>Warehouse</div>
        </AuditCaptureProvider>
      </CameraHealthProvider>,
    );
    const captures = FakeEventSource.instances.find((source) =>
      source.url.includes("/api/warehouse/captures/events"),
    );
    expect(captures).toBeDefined();

    act(() => emitReadyComparison(captures!));
    expect(await screen.findByText("Continue putaway")).toBeTruthy();

    act(() => captures!.emit("pending", { captureId: null }));

    await waitFor(() => {
      expect(screen.queryByText("Continue putaway")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("does not reopen a comparison when a decision finds it already terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: "This verification can no longer be cancelled." } }),
      } as Response)),
    );
    const { container } = render(
      <CameraHealthProvider>
        <AuditCaptureProvider>
          <div>Warehouse</div>
        </AuditCaptureProvider>
      </CameraHealthProvider>,
    );
    const captures = FakeEventSource.instances.find((source) =>
      source.url.includes("/api/warehouse/captures/events"),
    );
    act(() => emitReadyComparison(captures!));
    expect(await screen.findByText("Continue putaway")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel putaway" }));
    fireEvent.animationEnd(container.querySelector("[role='presentation']")!);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AuditCaptureProvider", () => {
  it("presents an automatic physical verification without infrastructure controls", async () => {
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

    act(() =>
      captures!.emit("pending", {
        captureId: "capture-verification",
        binCode: "B4-01",
        partName: "Mounting Hardware",
        purpose: "PUTAWAY",
        captureMode: "PROD",
        cameraJob: { status: "PENDING", queuePosition: 2 },
        analysis: null,
      }),
    );

    expect(await screen.findByText("Physical verification")).toBeTruthy();
    expect(screen.getByText("Mounting Hardware")).toBeTruthy();
    expect(screen.getByText("· Bin B4-01")).toBeTruthy();
    expect(screen.getByText("Camera + scale checking contents…")).toBeTruthy();
    expect(screen.getByText("Verifying physical inventory")).toBeTruthy();
    expect(screen.getByText("Automatic check — no action needed")).toBeTruthy();
    expect(screen.queryByText("Pi capture")).toBeNull();
    expect(screen.queryByText("Uploaded")).toBeNull();
    expect(screen.queryByText("Gemini")).toBeNull();
    expect(screen.queryByRole("button", { name: "Abort putaway" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry Pi capture" })).toBeNull();
  });

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
        tareWeightGrams: 107,
        netWeightGrams: 43,
        unitWeightGrams: 8.6,
        weightSource: "FALLBACK",
        previousImageUrl: null,
        currentImageUrl: null,
        foreignObjects: [],
        notes: "Five parts are visible.",
      },
    });
  }

  function emitAttentionComparison(captures: FakeEventSource) {
    captures.emit("pending", {
      captureId: "capture-attention",
      binCode: "B6-03",
      partName: "Aluminum Spacers",
      purpose: "PUTAWAY",
      captureMode: "PROD",
      analysis: {
        captureMode: "PROD",
        captureId: "capture-attention",
        binCode: "B6-03",
        status: "RETRY_REQUIRED",
        outcome: "FOREIGN_OBJECTS",
        expectedQuantity: 38,
        observedQuantity: 25,
        confidencePercent: 100,
        totalWeightGrams: 1,
        tareWeightGrams: 0,
        netWeightGrams: 1,
        unitWeightGrams: 0.04,
        weightSource: "SCALE",
        previousImageUrl: null,
        currentImageUrl: null,
        foreignObjects: ["white plastic bracket"],
        notes: "A white plastic bracket is mixed with the spacers.",
      },
    });
  }

  function emitAcceptedConfidenceDecrease(captures: FakeEventSource, operation: "RETRIEVAL" | "PUTAWAY" = "PUTAWAY") {
    captures.emit("pending", {
      captureId: "capture-decrease",
      binCode: "B6-03",
      partName: "Aluminum Spacers",
      purpose: "PUTAWAY",
      captureMode: "PROD",
      analysis: {
        operation,
        quantitySource: "SCALE",
        captureMode: "PROD",
        captureId: "capture-decrease",
        binCode: "B6-03",
        status: "REVIEW_DECREASE",
        outcome: "REVIEW_DECREASE",
        expectedQuantity: 30,
        observedQuantity: 27,
        confidencePercent: 80,
        totalWeightGrams: 274.4,
        tareWeightGrams: 107,
        netWeightGrams: 167.4,
        unitWeightGrams: 6.2,
        weightSource: "SCALE",
        previousImageUrl: null,
        currentImageUrl: null,
        foreignObjects: [],
        notes: "Twenty-seven expected parts are visible.",
      },
    });
  }

  it("shows the scale-derived quantity taken during putaway and closes automatically", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: "ACCEPTED" }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

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

    act(() => emitAcceptedConfidenceDecrease(captures!));

    expect(
      screen.getByText("Physical verification · Aluminum Spacers"),
    ).toBeTruthy();
    expect(screen.getByText("Bin B6-03")).toBeTruthy();
    expect(screen.getByText("Recorded")).toBeTruthy();
    expect(screen.getByText("Counted")).toBeTruthy();
    expect(screen.getByText("Decision")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.queryByText("Inventory mismatch found")).toBeNull();
    expect(screen.getByText("Engineer took 3 items")).toBeTruthy();
    expect(screen.getByText("Scale: 167.4 g net ÷ 6.2 g per item")).toBeTruthy();
    expect(
      screen.getByText(/Verified inventory:/).textContent,
    ).toContain("30 → 27");
    expect(screen.getByText("✓ Returning bin automatically")).toBeTruthy();
    expect(screen.queryByText("Confidence")).toBeNull();
    expect(screen.queryByText("80")).toBeNull();
    expect(screen.queryByText("Twenty-seven expected parts are visible.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry photo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel putaway" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    fireEvent.animationEnd(container.querySelector("[role='presentation']")!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/warehouse/putaway/captures/capture-decrease/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "ACCEPT" }),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

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

  it("keeps a retrieval correction at checkout rather than promising a return", async () => {
    render(
      <CameraHealthProvider>
        <AuditCaptureProvider><div>Warehouse</div></AuditCaptureProvider>
      </CameraHealthProvider>,
    );
    const captures = FakeEventSource.instances.find((source) => source.url.includes("/api/warehouse/captures/events"));
    act(() => emitAcceptedConfidenceDecrease(captures!, "RETRIEVAL"));
    expect(screen.getByText("✓ Bin ready at checkout automatically")).toBeTruthy();
    expect(screen.queryByText("✓ Returning bin automatically")).toBeNull();
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

  it("automatically accepts a verified count after five seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: "ACCEPTED" }),
    } as Response));
    vi.stubGlobal("fetch", fetchMock);

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
    expect(
      screen.getByText(/Returning bin unchanged in 5s/),
    ).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    fireEvent.animationEnd(container.querySelector("[role='presentation']")!);
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/warehouse/putaway/captures/capture-1/decision",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "ACCEPT" }),
      }),
    );
  });

  it("keeps a putaway attention result open until the operator decides", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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

    act(() => emitAttentionComparison(captures!));
    expect(screen.getByText("Physical check uncertain")).toBeTruthy();
    expect(
      screen.getByText(
        "Scale and visual evidence do not agree clearly enough. Inventory was not changed. Engineer check required.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Estimated")).toBeTruthy();
    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Removed · retry photo" })).toBeTruthy();
    expect(screen.queryByText(/Returning bin unchanged in/)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText("Physical check uncertain")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

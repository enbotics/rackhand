// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GuidedPutawayDialog } from "@/components/warehouse/guided-putaway-dialog";
import type { ScanState } from "@/components/warehouse/state";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SCAN_STATE: ScanState = {
  phase: "READY",
  failure: null,
  scan: {
    shotId: "shot_1",
    capturedAt: 1_700_000_000_000,
    measurement: {
      name: "ball bearing",
      description: "small steel bearing",
      lengthMM: 47,
      widthMM: 47,
      heightMM: 14,
      angleDegrees: 0,
      dimensionConfidence: 0.96,
      calibrationRmsPixels: 1.2,
      measuredAt: 1_700_000_000_000,
    },
    scanResult: {
      scanId: "scan_guided_1",
      capturedAt: 1_700_000_000_000,
      object: { detectedName: "ball bearing", description: "small steel bearing" },
      dimensions: { lengthMM: 47, widthMM: 47, heightMM: 14 },
      quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.2 },
      orientation: { angleDegrees: 0 },
    },
    issues: [],
    match: {
      status: "MATCHED",
      confidence: 0.97,
      matchedPart: {
        id: "part_1",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        category: "bearing",
      },
      evidence: {
        nameScore: 0.9,
        dimensionScore: 0.95,
        descriptionScore: 0.5,
        scanQualityScore: 0.96,
        planarDimensionErrorMM: 0,
        heightErrorMM: 0,
        matchedIdentifierTokens: ["6204"],
      },
      alternatives: [],
    },
    matchError: null,
  },
};

function response(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  } as Response);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("guided putaway dialog", () => {
  it("shows separate gantry/database states and saves only after confirmation", async () => {
    const presentation = deferred<Response>();
    const returned = deferred<Response>();
    const committed = deferred<Response>();
    const requests: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === "/api/warehouse/guided-putaway") {
          return response({
            ok: true,
            stage: "RESERVED",
            movementId: "movement_1",
            scanId: "scan_guided_1",
            destinationBinCode: "B1-02",
            part: {
              partId: "part_1",
              sku: "BRG-6204",
              canonicalName: "6204 Deep Groove Ball Bearing",
            },
            databaseStatus: "RESERVED",
            gantryStatus: "IDLE",
          });
        }
        if (url.endsWith("/present")) return presentation.promise;
        if (url.endsWith("/return")) return returned.promise;
        if (url.endsWith("/commit")) return committed.promise;
        if (url === "/api/gantry/status") {
          return response({
            mode: "SIMULATION",
            state: "MOVING",
            currentLocation: "B1-02",
            homed: true,
            activeOperationId: "gantry_1",
            lastError: null,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const { container } = render(
      <GuidedPutawayDialog
        scanState={SCAN_STATE}
        identity="MATCHED"
        confirmed={null}
        identification={null}
        identityRejected={false}
        identityBusy={false}
        identityError={null}
        openRequestVersion={0}
        bins={[
          {
            binId: "bin_1",
            code: "B1-02",
            status: "AVAILABLE",
            capacity: 100,
            contents: [],
            totalQuantity: 0,
          },
        ]}
        gantry={null}
        shots={[]}
        onSelectIdentity={() => {}}
        onRejectIdentity={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={false}
        registerError={null}
        onWarehouseChanged={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("BRG-6204")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "B1-02" }));

    await waitFor(() => expect(screen.getByText("Fetching bin")).toBeTruthy());
    expect(container.querySelector(".animate-bin-fetch")).toBeTruthy();
    expect(screen.getByText("Slot reserved")).toBeTruthy();
    expect(requests.some((url) => url.endsWith("/return"))).toBe(false);
    expect(requests.some((url) => url.endsWith("/commit"))).toBe(false);

    presentation.resolve(
      await response({
        ok: true,
        stage: "AWAITING_PLACEMENT",
        movementId: "movement_1",
        scanId: "scan_guided_1",
        destinationBinCode: "B1-02",
        part: {
          partId: "part_1",
          sku: "BRG-6204",
          canonicalName: "6204 Deep Groove Ball Bearing",
        },
        databaseStatus: "WAITING_TO_SAVE",
        gantryStatus: "WAITING_FOR_PLACEMENT",
      }),
    );

    await waitFor(() => expect(screen.getByText("Waiting for placement")).toBeTruthy());
    expect(screen.getByText("Waiting to save")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, item placed" }));

    await waitFor(() => expect(screen.getByText("Returning bin")).toBeTruthy());
    expect(screen.getByText("Waiting to save")).toBeTruthy();

    returned.resolve(
      await response({
        ok: true,
        stage: "BIN_RETURNED",
        movementId: "movement_1",
        scanId: "scan_guided_1",
        destinationBinCode: "B1-02",
        part: {
          partId: "part_1",
          sku: "BRG-6204",
          canonicalName: "6204 Deep Groove Ball Bearing",
        },
        databaseStatus: "SAVING",
        gantryStatus: "COMPLETED",
      }),
    );

    await waitFor(() => expect(screen.getByText("Saving inventory")).toBeTruthy());
    expect(screen.getByText("Movement complete")).toBeTruthy();

    committed.resolve(
      await response({
        ok: true,
        stage: "COMPLETED",
        movementId: "movement_1",
        scanId: "scan_guided_1",
        destinationBinCode: "B1-02",
        part: {
          partId: "part_1",
          sku: "BRG-6204",
          canonicalName: "6204 Deep Groove Ball Bearing",
        },
        databaseStatus: "SAVED",
        gantryStatus: "COMPLETED",
        inventoryQuantityAdded: 1,
      }),
    );

    await waitFor(() => expect(screen.getByText("Inventory saved")).toBeTruthy());
    expect(screen.getByText("Movement complete")).toBeTruthy();
    expect(screen.getByText("Putaway complete")).toBeTruthy();
  });

  /**
   * The regression this dialog actually shipped with. The test above proves the
   * animation and the commit sequence are right GIVEN a ready identity — but it
   * hardcodes identity="MATCHED", which is the one thing a real scan of an
   * unknown object never produces. In the running app the matcher returned
   * NO_MATCH, `identityReady` was false, and the slot section had no else
   * branch: no grid, no count, no reason, and no gantry panel either (that only
   * mounts once a slot has been picked). The operator saw an open dialog with
   * nothing in it and read it as a broken feature.
   */
  it("explains why no slots are offered when the scan has no catalog identity", () => {
    const scanState: ScanState = {
      ...SCAN_STATE,
      scan: {
        ...SCAN_STATE.scan!,
        match: {
          status: "NO_MATCH",
          confidence: 0.06,
          reason: "No catalog part reached the plausibility floor of 0.35.",
          candidates: [],
        },
      },
    };

    const { container } = render(
      <GuidedPutawayDialog
        scanState={scanState}
        identity="NO_MATCH"
        confirmed={null}
        identification={null}
        identityRejected={false}
        identityBusy={false}
        identityError={null}
        openRequestVersion={0}
        bins={[
          {
            binId: "bin_1",
            code: "B1-02",
            status: "AVAILABLE",
            capacity: 100,
            contents: [],
            totalQuantity: 0,
          },
        ]}
        gantry={null}
        shots={[]}
        onSelectIdentity={() => {}}
        onRejectIdentity={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={false}
        registerError={null}
        onWarehouseChanged={() => {}}
      />,
    );

    expect(screen.getByText(/Putaway unavailable/)).toBeTruthy();
    expect(screen.getByText(/Register it as a new catalog part below/)).toBeTruthy();
    // The shelf is not the problem, and the operator must be able to see that.
    expect(screen.getByText("1 available")).toBeTruthy();
    // An unidentified scan still may not pick a slot.
    expect(screen.queryByRole("button", { name: "B1-02" })).toBeNull();
    expect(container.querySelector(".animate-bin-fetch")).toBeNull();
    // NO_MATCH specifically offers a way forward, not just a dead end.
    expect(screen.getByRole("button", { name: "Register as new part" })).toBeTruthy();
  });

  it("calls onRegisterNewPart when the operator registers a NO_MATCH scan", () => {
    const scanState: ScanState = {
      ...SCAN_STATE,
      scan: {
        ...SCAN_STATE.scan!,
        match: {
          status: "NO_MATCH",
          confidence: 0.06,
          reason: "No catalog part reached the plausibility floor of 0.35.",
          candidates: [],
        },
      },
    };
    const onRegisterNewPart = vi.fn();

    render(
      <GuidedPutawayDialog
        scanState={scanState}
        identity="NO_MATCH"
        confirmed={null}
        identification={null}
        identityRejected={false}
        identityBusy={false}
        identityError={null}
        openRequestVersion={0}
        bins={[]}
        gantry={null}
        shots={[]}
        onSelectIdentity={() => {}}
        onRejectIdentity={() => {}}
        onRegisterNewPart={onRegisterNewPart}
        registeringPart={false}
        registerError={null}
        onWarehouseChanged={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Register as new part" }));
    expect(onRegisterNewPart).toHaveBeenCalledTimes(1);
  });

  it("shows a register error and disables the button while registering", () => {
    const scanState: ScanState = {
      ...SCAN_STATE,
      scan: {
        ...SCAN_STATE.scan!,
        match: {
          status: "NO_MATCH",
          confidence: 0.06,
          reason: "No catalog part reached the plausibility floor of 0.35.",
          candidates: [],
        },
      },
    };

    render(
      <GuidedPutawayDialog
        scanState={scanState}
        identity="NO_MATCH"
        confirmed={null}
        identification={null}
        identityRejected={false}
        identityBusy={false}
        identityError={null}
        openRequestVersion={0}
        bins={[]}
        gantry={null}
        shots={[]}
        onSelectIdentity={() => {}}
        onRejectIdentity={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={true}
        registerError="The warehouse could not be reached. Try again."
        onWarehouseChanged={() => {}}
      />,
    );

    expect(screen.getByText("The warehouse could not be reached. Try again.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Registering…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("reopens when the agent hands a putaway request to the guided workflow", async () => {
    const props = {
      scanState: SCAN_STATE,
      identity: "MATCHED" as const,
      confirmed: null,
      identification: null,
      identityRejected: false,
      identityBusy: false,
      identityError: null,
      bins: [
        {
          binId: "bin_1",
          code: "B1-02",
          status: "AVAILABLE" as const,
          capacity: 100,
          contents: [],
          totalQuantity: 0,
        },
      ],
      gantry: null,
      shots: [],
      onSelectIdentity: () => {},
      onRejectIdentity: () => {},
      onRegisterNewPart: () => {},
      registeringPart: false,
      registerError: null,
      onWarehouseChanged: () => {},
    };
    const { rerender } = render(
      <GuidedPutawayDialog {...props} openRequestVersion={0} />,
    );

    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    rerender(<GuidedPutawayDialog {...props} openRequestVersion={1} />);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });
});

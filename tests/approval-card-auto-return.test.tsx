// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "@/components/warehouse/approval-card";
import type { PendingApprovalView } from "@/components/warehouse/state";

const approval: PendingApprovalView = {
  approvalId: "approval-return-b4-01",
  action: "execute_putaway",
  expiresAt: "2026-09-13T12:00:00.000Z",
  summary: {
    action: "PUTAWAY",
    sku: "HARDWARE-V-GROOVE-WHEEL-KIT",
    canonicalName: "V-groove bearing wheel hardware kit",
    source: "OUTPUT",
    destination: "B4-01",
    quantity: 10,
    autoSuggested: true,
    fulfillmentQueue: ["B3-03", "B6-03"],
    fulfillmentTotal: 3,
  },
};

const retrievalApproval: PendingApprovalView = {
  approvalId: "approval-retrieve-b3-03",
  action: "execute_retrieval",
  expiresAt: "2026-09-13T12:00:00.000Z",
  summary: {
    action: "RETRIEVAL",
    sku: null,
    canonicalName: null,
    source: "B3-03",
    destination: "OUTPUT",
    quantity: null,
  },
};

describe("approval card automatic bin return", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("gives the operator twenty seconds before automatically returning the bin", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={approval}
        outcome={null}
        busy={false}
        latestMovement={null}
        gantry={null}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("Returning automatically in 20s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(19_000));
    expect(onDecide).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith("APPROVE");
  });

  it("cancels the countdown when the operator chooses not now", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={approval}
        outcome={null}
        busy={false}
        latestMovement={null}
        gantry={null}
        onDecide={onDecide}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    act(() => vi.advanceTimersByTime(20_000));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith("DENY");
  });

  it("automatically approves a retrieval after five seconds", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={retrievalApproval}
        outcome={null}
        busy={false}
        latestMovement={null}
        gantry={null}
        onDecide={onDecide}
      />,
    );

    expect(screen.getByText("Retrieving automatically in 5s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith("APPROVE");
  });

  it("does not auto-approve a retrieval after it is denied", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={retrievalApproval}
        outcome={null}
        busy={false}
        latestMovement={null}
        gantry={null}
        onDecide={onDecide}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith("DENY");
  });

  it("starts the explicit browser scenario automatically, without changing ordinary prep approvals", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={{ ...approval, approvalId: "demo-start", summary: {
      ...approval.summary, action: "MATERIALS_FULFILLMENT", autoSuggested: false, browserScenario: "CONTROL_MODULE", quantity: 3,
    } }} outcome={null} busy={false} latestMovement={null} onDecide={onDecide} />);
    expect(screen.getByText("Browser simulation · starting automatically in 5s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(5_000));
    expect(onDecide).toHaveBeenCalledOnce();
    expect(onDecide).toHaveBeenCalledWith("APPROVE");
  });
});

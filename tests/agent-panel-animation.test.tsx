// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPanel } from "@/components/warehouse/agent-panel";
import type { AgentTurn } from "@/components/warehouse/state";

describe("warehouse agent reply animation", () => {
  let nextFrame: FrameRequestCallback | undefined;

  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("progressively reveals only a newly received agent reply", () => {
    const response = "Four available slots are ready for guided putaway.";
    const baseProps = {
      busy: false,
      unavailable: false,
      error: null,
      scanAttached: true,
      identityAttached: true,
      onSend: vi.fn(),
      onRetry: vi.fn(),
      identification: null,
      confirmed: null,
      identityRejected: false,
      identityBusy: false,
      identityError: null,
      onSelectIdentity: vi.fn(),
      onRejectIdentity: vi.fn(),
      onRegisterNewPart: vi.fn(),
      registeringPart: false,
      registerError: null,
      detectedName: null,
      approval: null,
      outcome: null,
      onDecide: vi.fn(),
      gantry: null,
      latestMovement: null,
      workflow: null,
      latestAudit: null,
    };
    const { container, rerender } = render(<AgentPanel {...baseProps} turns={[]} />);
    const turn: AgentTurn = {
      id: "agent-new",
      role: "agent",
      text: response,
      tools: ["list_available_bins"],
    };

    rerender(<AgentPanel {...baseProps} turns={[turn]} />);

    const reply = screen.getByLabelText(response);
    expect(reply.textContent).toBe("");
    expect(container.querySelector(".agent-typing-cursor")).not.toBeNull();
    expect(screen.getByText("Available slots")).toBeTruthy();

    act(() => nextFrame?.(Number.MAX_SAFE_INTEGER));

    expect(reply.textContent).toBe(response);
    expect(container.querySelector(".agent-typing-cursor")).toBeNull();
  });
});

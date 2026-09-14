// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditCaptureModeToggle } from "@/components/warehouse/audit-capture-mode-toggle";
import { WarehouseNav } from "@/components/warehouse/nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/warehouse/session", () => ({
  useWarehouseSession: () => ({
    totals: null,
    gantry: { mode: "SIMULATION" },
    approval: null,
    identification: null,
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("simulation guide", () => {
  it("labels a production deployment without showing the Simulation lock or guide", () => {
    render(<AuditCaptureModeToggle mode="PRODUCTION" locked={false} />);
    expect(screen.getByText("Production · Klipper")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Simulation locked — view demo guide",
      }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens the floating dialog by default with the lock, allowed bins and prompts", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { container } = render(
      <section style={{ overflow: "hidden" }}>
        <AuditCaptureModeToggle />
      </section>,
    );
    const trigger = screen.getByRole("button", {
      name: "Simulation locked — view demo guide",
    });
    const guide = await screen.findByRole("dialog", {
      name: "Simulation demo guide",
    });
    expect(guide.getAttribute("aria-modal")).toBe("false");
    expect(container.contains(guide)).toBe(false);
    expect(
      screen.getByText(/Prod mode can trigger real hardware/),
    ).toBeTruthy();
    expect(screen.getByText("B1-01")).toBeTruthy();
    expect(screen.getByText("B1-02")).toBeTruthy();
    expect(
      screen.getByText(
        "“RackHand, prep the self-tapping screws for the sensor enclosure.”",
      ),
    ).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close simulation guide" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Simulation demo guide" }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses and reopens with Escape, pointer input, the trigger or Got it", async () => {
    render(<AuditCaptureModeToggle />);
    const trigger = screen.getByRole("button", {
      name: "Simulation locked — view demo guide",
    });
    await screen.findByRole("dialog", { name: "Simulation demo guide" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores the gantry mode badge in the page header", () => {
    render(<WarehouseNav />);
    expect(screen.getByText(/GANTRY MODE: SIMULATION/)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinDetailModal } from "@/components/warehouse/bin-detail-modal";
import type { BinView } from "@/lib/warehouse/dashboard-types";

afterEach(cleanup);

describe("BinDetailModal photos", () => {
  it("shows the catalog photo when the bin has no placement photo", () => {
    const bin: BinView = {
      binId: "bin-b6-01",
      code: "B6-01",
      status: "OCCUPIED",
      capacity: 100,
      totalQuantity: 24,
      latestSnapshot: null,
      contents: [
        {
          partId: "hose-clamps",
          sku: "HARDWARE-HOSE-CLAMP-MIXED",
          canonicalName: "Assorted worm-drive hose clamps",
          quantity: 24,
          imageUrl: null,
          catalogImageUrl: "/api/camera/captures/hose-clamps/image",
        },
      ],
    };

    render(<BinDetailModal bin={bin} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(
      screen.getByRole("img", { name: "Assorted worm-drive hose clamps" }).getAttribute("src"),
    ).toBe("/api/camera/captures/hose-clamps/image");
    expect(screen.queryByText("No photo")).toBeNull();
  });
});

import type { Metadata } from "next";
import { Sora, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { WarehouseNav } from "@/components/warehouse/nav";
import { WarehouseSessionProvider } from "@/components/warehouse/session";
import { CameraProvider } from "@/lib/camera-context";
import { AuditCaptureProvider } from "@/components/warehouse/audit-capture-dialog";

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Agentic Spare Parts Warehouse",
  description:
    "Warehouse command centre: scan a part, identify it against the catalog, and run approved putaway and retrieval through the warehouse agent.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${plexMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col relative bg-bg text-ink">
        <div className="atmosphere" aria-hidden="true" />
        {/*
          The session lives ABOVE the router outlet so a half-finished scan or
          a pending approval survives moving between pages. Losing an approval
          card by clicking a menu item would leave the operator unable to
          answer a question the server is still holding open.
        */}
        {/*
          The camera sits beside the session, above the router, for the same
          reason: it is the operator's ONE physical device, not a property of
          /scan. An inventory audit started from the chat on the landing page
          needs a live frame there and then — walking to another page to open
          a camera is how audits used to die with capture_station_unavailable.
        */}
        <CameraProvider>
          <WarehouseSessionProvider>
            <AuditCaptureProvider>
              <div className="relative z-10 flex flex-1 flex-col">
                <WarehouseNav />
                <main className="flex flex-1 flex-col">{children}</main>
              </div>
            </AuditCaptureProvider>
          </WarehouseSessionProvider>
        </CameraProvider>
      </body>
    </html>
  );
}

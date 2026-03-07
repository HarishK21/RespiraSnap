import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RespiraSnap",
  description: "Breathing Snapshot landing experience with procedural 3D orb."
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

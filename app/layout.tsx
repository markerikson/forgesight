import type { ReactNode } from "react";
import "../src/web/styles/global.css";

export const metadata = {
  title: "Forgesight",
  icons: { icon: [{ url: "/favicon.svg", type: "image/svg+xml" }] },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

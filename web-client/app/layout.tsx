import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Web Client",
  description: "Chat interface for ai-gateway-live",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}

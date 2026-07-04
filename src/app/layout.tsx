import type { Metadata, Viewport } from "next";
import { inter } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "BookLets - Open Source Bookkeeping",
  description: "Bookkeeping for Short-Term Rental Businesses",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "BookLets",
    statusBarStyle: "black-translucent",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f19",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body className={inter.className}>
        {children}
      </body>
    </html>
  );
}

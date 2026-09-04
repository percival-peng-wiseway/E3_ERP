import type { Metadata, Viewport } from "next";
import e3AppIcon from "@/assets/e3-energy-app-icon.png";
import e3ShareImage from "@/assets/e3-energy-share.png";
import "./globals.css";

const title = "E3 ERP · Business Operations Workspace";
const description = "E3 Energy's unified workspace for files, inventory, quotations, project delivery and business operations.";

export const metadata: Metadata = {
  metadataBase: new URL("https://erp.e3energy.com.au"),
  applicationName: "E3 ERP",
  title,
  description,
  icons: {
    icon: [{ url: e3AppIcon.src, type: "image/png", sizes: "512x512" }],
    shortcut: [{ url: e3AppIcon.src, type: "image/png", sizes: "512x512" }],
    apple: [{ url: e3AppIcon.src, type: "image/png", sizes: "512x512" }],
  },
  openGraph: {
    title,
    description,
    siteName: "E3 ERP",
    locale: "en_AU",
    type: "website",
    images: [{ url: e3ShareImage.src, width: 1200, height: 630, alt: "E3 Energy" }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: e3ShareImage.src, alt: "E3 Energy" }],
  },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f3f5f7",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}

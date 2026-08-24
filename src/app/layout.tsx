import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Unify ERP · Business Operations Workspace",
  description: "A unified workspace for inventory, quotations, delivery operations and reimbursements.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-AU">
      <body>{children}</body>
    </html>
  );
}

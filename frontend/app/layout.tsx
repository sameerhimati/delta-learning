import type { Metadata } from "next";
import { Provider } from "@/components/Provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Delta Learning",
  description: "Watch what is new to you, capture it, and make the next video shorter.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}

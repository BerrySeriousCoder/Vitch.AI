import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Toaster } from "sonner";
import { AuthProvider } from "@/components/providers/AuthProvider";
import "./globals.css";

const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Tempo — AI Video Editor",
  description:
    "AI-powered video editor built for professionals. Clean, fast, and precise.",
  keywords: ["video editor", "AI", "creative director", "motion graphics"],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${plusJakarta.variable} h-full dark`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col antialiased bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <AuthProvider>{children}</AuthProvider>
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}

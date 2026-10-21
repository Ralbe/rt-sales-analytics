import type { Metadata } from "next";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import "./globals.css";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Аналитика продаж",
  description: "Воронка, проекты и конструктор отчётов",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { FontSettingsApplier } from "@/components/FontSettings";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
      }),
  );
  return <QueryClientProvider client={client}><FontSettingsApplier />{children}</QueryClientProvider>;
}

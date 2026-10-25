"use client";

import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("./ChartRenderer"), { ssr: false });

export const PALETTE = ["#6c3fd1", "#ff8a3d", "#2b9bd8", "#1a8f5a", "#d6457a", "#c9a227", "#4a6fe3", "#8a8f9f"];

export function Chart({ option }: { option: EChartsOption }) {
  return (
    <ReactECharts
      theme="v5"
      option={{
        color: PALETTE,
        textStyle: { fontFamily: "Inter, system-ui, sans-serif" },
        animationDuration: 300,
        ...option,
      }}
      style={{ height: "100%", width: "100%" }}
      notMerge
      lazyUpdate
    />
  );
}

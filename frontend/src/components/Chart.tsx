"use client";

import type { EChartsOption } from "echarts";
import dynamic from "next/dynamic";
import { useRef } from "react";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export const PALETTE = ["#6c3fd1", "#ff8a3d", "#2b9bd8", "#1a8f5a", "#d6457a", "#c9a227", "#4a6fe3", "#8a8f9f"];

export function Chart({ option, printable = false }: { option: EChartsOption; printable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={printable ? "print-chart" : undefined} data-print-chart={printable ? "pending" : undefined} style={printable ? undefined : { height: "100%", width: "100%" }}>
      <ReactECharts
        option={{
          color: PALETTE,
          textStyle: { fontFamily: "Inter, system-ui, sans-serif" },
          animationDuration: 300,
          ...option,
          ...(printable ? { animation: false } : {}),
        }}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate={!printable}
        opts={printable ? { renderer: "svg" } : undefined}
        onChartReady={printable ? (chart) => {
          chart.resize();
          if (ref.current) ref.current.dataset.printChart = "ready";
        } : undefined}
      />
    </div>
  );
}

import type { RefItem, Refs } from "@/lib/types";

function filterOptions(items: (RefItem & { is_active?: boolean })[]): RefItem[] {
  return items.map((item) => ({ ...item, name: item.name + (item.is_active === false ? " (неактивно)" : "") }));
}

export const segmentFilterOptions = (refs: Refs) => filterOptions(refs.filter_segments ?? refs.segments);
export const serviceFilterOptions = (refs: Refs) => filterOptions(refs.filter_services ?? refs.services);

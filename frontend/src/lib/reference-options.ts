import type { ManagerItem, RefItem, Refs } from "@/lib/types";

function filterOptions(items: (RefItem & { is_active?: boolean })[]): RefItem[] {
  return items.map((item) => ({ ...item, name: item.name + (item.is_active === false ? " (неактивно)" : "") }));
}

export const segmentFilterOptions = (refs: Refs) => filterOptions(refs.filter_segments ?? refs.segments);
export const serviceFilterOptions = (refs: Refs) => filterOptions(refs.filter_services ?? refs.services);

export function managerFilterOptions(refs: Refs, selected: number[] = []): RefItem[] {
  const options = (refs.filter_managers ?? refs.managers).map((item) => ({
    id: item.id, name: item.full_name + ("is_active" in item && item.is_active === false ? " (неактивен)" : ""),
  }));
  return [...options, ...selected.filter((id) => !options.some((item) => item.id === id))
    .map((id) => ({ id, name: `Недоступное значение (ID ${id})` }))];
}

export function managerName(manager: ManagerItem, refs?: Refs): string {
  const saved = refs?.filter_managers?.find((item) => item.id === manager.id);
  const inactive = saved ? !saved.is_active : refs ? !refs.managers.some((item) => item.id === manager.id) : false;
  return manager.full_name + (inactive ? " (неактивен)" : "");
}

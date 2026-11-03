import styles from "./ProjectSummaryCounts.module.css";

type Props = {
  total: number;
  detailLabel: string;
  detailCount: number;
};

export function ProjectSummaryCounts({ total, detailLabel, detailCount }: Props) {
  return <dl className={styles.counts}>
    <div>
      <dt>Проектов</dt>
      <dd>{total}</dd>
    </div>
    <div>
      <dt>{detailLabel}</dt>
      <dd>{detailCount}</dd>
    </div>
  </dl>;
}

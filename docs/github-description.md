# Update project analytics, report history and Excel import

- Add calculated revenue, costs and profit to the project register and report builder.
- Group project trends by month and add year/month filters. Update charts, units and the largest-projects table.
- Add mean, median and modes for completed stage visits. Fix Gantt interval boundaries and allow project print fields to be selected.
- Save permanent report versions. Add Excel import with column mapping, preview, VAT selection and an import log.
- Fix open-project filtering, archive access and duplicate submissions. Apply consistent typography and simplify the launch script.
- Improve form spacing and mobile dashboard layout. Keep prepared print snapshots intact during background data updates.

Validation: 610 backend tests, 234 browser scenarios with API fixtures, 4 live browser scenarios, Ruff, TypeScript, ESLint and production builds passed. The full Docker setup was also checked with the supplied Excel example and saved-report export. Forms, tables and charts were reviewed at desktop and mobile widths.

Contract allocation by stage still needs a business decision. This version improves the existing monthly entries.

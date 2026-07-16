# hypnogram_viz — Splunk Dashboard Studio custom visualization

A stepped **category-over-time "hypnogram"** for Splunk Dashboard Studio — horizontal
lanes with filled blocks and vertical risers at transitions. Built for the companion
**oura_health** Sleep & Activity dashboards (sleep stages, HR zones), but generic:
configurable lanes make it work for any staged/zoned timeline.

**Viz type string:** `hypnogram_viz.hypnogram`

## Options (set on the panel; `optionsSchema`-declared so they forward)
| option | type | default | notes |
|--------|------|---------|-------|
| `lanes` | JSON **string** | sleep stages | ordered top→bottom `[{"label","color"}]`; the data `stage` value must match a `label` |
| `slotMinutes` | number | auto (smallest offset gap) | minutes represented by each row |
| `contentOpacity` | number | 0.85 | opacity of blocks/risers (lets a translucent panel bg show through) |
| `backgroundColor` | string | — | native panel background (use a translucent value) |

## Data contract
Columns: `offset_min` (number), `time_label` (`HH:MM`), `stage`, and optional
`date_label` (enables a date-aware axis for multi-day ranges). See `visualizations/hypnogram/SPL.md`.

## Build & package
```bash
npm install
npm run build:prod
npm run package        # -> dist/hypnogram_viz-<version>-<hash>.spl
```
Install the `.spl` via Splunk Web (Apps → Install app from file). After a viz-code
update, bump Splunk's static-asset cache (`/en-US/_bump`) or restart, then hard-refresh.

Framework: `@splunk/dashboard-studio-extension`. Passes Splunk Cloud AppInspect (cloud tags).

## Related repositories

- **[oura-health-splunk](https://github.com/narwhaldc/oura-health-splunk)** — the Splunk app + ingest pipeline this viz was built for
- **[charge_ring_viz](https://github.com/narwhaldc/charge_ring_viz)** — companion battery / charge-status ring viz

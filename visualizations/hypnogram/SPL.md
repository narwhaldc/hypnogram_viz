# Hypnogram — SPL Reference

Renders a single night's sleep-stage timeline as a proper stepped hypnogram
(lanes: Awake → REM → Light → Deep, top to bottom).

## Expected Columns

| Column       | Type   | Required? | Description |
|--------------|--------|-----------|-------------|
| `offset_min` | number | Yes       | Minutes elapsed since sleep start for this 5-min slot (0, 5, 10, …). Drives X position. |
| `time_label` | string | Yes       | Local clock time for the slot, `HH:MM` (24h). Used for axis ticks and tooltips. |
| `stage`      | string | Yes       | One of `Deep`, `Light`, `REM`, `Awake`. Anything else is ignored. |

Rows must be ordered by `offset_min` ascending (the SPL below does this).

## Notes

- Source field `sleep_phase_5_min` encodes one digit per 5-minute slot:
  `1`=Deep, `2`=Light, `3`=REM, `4`=Awake.
- `time_label` is computed with modular clock arithmetic from `bedtime_start`
  (parsing the `HH:MM` out of the ISO string) so it stays in the *sleep location's*
  local timezone rather than the browser's — matching the Oura app.
- The viz collapses consecutive equal stages into blocks and draws vertical risers
  at transitions. Each slot is assumed to be 5 minutes.

## Full SPL

```spl
index=oura oura_data_type=sleep_detail
| dedup day sortby -total_sleep_duration
| sort -_time | head 1
| rex field=bedtime_start "T(?P<bed_h>\d{2}):(?P<bed_m>\d{2})"
| eval bed_h=tonumber(bed_h), bed_m=tonumber(bed_m), bed_total_mins=(bed_h*60)+bed_m
| rex field=sleep_phase_5_min max_match=0 "(?P<phases>.)"
| mvexpand phases
| streamstats count as idx
| eval offset_min=(idx-1)*5,
       total_mins=bed_total_mins+offset_min,
       h=floor(total_mins/60) % 24, m=total_mins % 60,
       hh=if(h<10,"0".tostring(h),tostring(h)), mm=if(m<10,"0".tostring(m),tostring(m)),
       time_label=hh.":".mm,
       stage=case(phases="1","Deep",phases="2","Light",phases="3","REM",phases="4","Awake",true(),"Unknown")
| where stage!="Unknown"
| table offset_min, time_label, stage
```

## Time range

`-2d` to `now` (the query itself pins to the most recent night via `sort -_time | head 1`).
```

# Xray test cases

One folder per Jira ticket, written by the [TB-TAF](https://github.com/regina-triparc/TB-TAF)
QA agent in the same commit as the ticket's Playwright spec (`e2e/qa/<TICKET>.spec.ts`):

```
xray/<TICKET>/
  <TICKET>.xray.json      Xray Cloud bulk-import payload - exactly what is exported
  <TICKET>.xray.csv       the same test cases for Xray's Test Case Importer (manual import)
  <TICKET>.test-plan.md   the plan in readable form, for review
```

## Lifecycle

1. **Generated.** The agent pushes them on the branch `qa/<TICKET>` together with
   the spec.
2. **Reviewed.** Read `<TICKET>.test-plan.md` in the pull request. To change what
   goes to Xray, edit `<TICKET>.xray.json` on the branch: fix steps, drop cases,
   adjust expected results.
3. **Merged** into `main`.
4. **Exported** to Jira from TB-TAF:

   ```bash
   python -m taf xray export TB-601
   ```

   ```bash
   python -m taf xray export TB-601 --apply
   ```

   The first reads the merged `xray/TB-601/TB-601.xray.json` from `main` and shows
   what would be imported. The second imports it (needs `XRAY_CLIENT_ID` /
   `XRAY_CLIENT_SECRET` in TB-TAF's `.env`).

Exporting the same ticket twice creates a second set of tests in Xray, so export
once, after merge.

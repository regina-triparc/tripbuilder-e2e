# services/hotel — hotel service lifecycle on a trip

Coverage for hotel services as they appear on a trip's **Itinerary** tab (`/tsp/:tripId/itinerary`,
apps/tsp). Sibling folders under `e2e/services/` can follow for ground, activity and air.

```bash
npm run e2e:hotel-headed
```

Its own `services-hotel` Playwright project, separate from `traveler-ui`, because these assert
against **shopping-gateway** rather than make-payable — a failure here should never read as a
traveller-event failure.

## What the UI actually does

Read from `apps/tsp/.../itinerary-view/itinerary-view.component.ts`, not guessed:

| Action | What happens | Testable here? |
|---|---|---|
| **Add Service** | publishes `requestOpenShopping({mode:'add'})` → opens the nested **shopping** remote | no — it's a shopping-picker flow |
| **Modify** | the same picker in `mode:'replace'`, carrying `serviceId` + type; disabled when `canReplace()` is false (e.g. Dining) | availability only |
| **Delete** | `DELETE {shopping-management}/trips/{tripId}/services/{id}?expectedVersion=N` | **yes** — the one write that stays in this tab |
| **Row click** | opens the read-only detail sheet (`sds-*`); Modify/Delete stop propagation so the sheet doesn't open underneath them | yes |

## Cases

| Test | Asserts | Destructive |
|---|---|---|
| itinerary lists the hotel service | the row exists and both Modify and Delete are enabled (hotel has a shoppable equivalent, so `canReplace()` is true) | no |
| detail sheet renders the hotel branch | `sds-hotel-phone` is present — the marker that the **hotel** branch rendered rather than ground/activity/air. Its value may legitimately be blank | no |
| day view vs Services view agree | a service in one view and missing from the other; two renders of one dataset, and only a cross-view check catches a divergence | no |
| deleting removes it from the read model | 2xx, an `expectedVersion` on the request, a recoverable `travelServiceId`, and the id **absent from `{shopping-inquiry}/trips/{id}/itinerary`** afterwards | **yes** |

## Setup

| Env var | For |
|---|---|
| `TB_HOTEL_TRIP_ID` | the three read-only cases — a dev trip that has a hotel service |
| `TB_HOTEL_DESTRUCTIVE_TRIP_ID` | the delete case — a **throwaway** trip whose hotel service may be destroyed |
| `TB_HOTEL_SERVICE_NAME` | row-name fragment to match (default `Hotel`) |

Everything skips when its variable is unset, and the delete case is deliberately behind a *second*
variable so a routine run cannot destroy a service by accident.

## Two honest limits

**Selectors.** The itinerary rows carry **no `data-test` attributes at all** — no row hook, no
Modify/Delete hooks, no "Add Service" hook, and no `travelServiceId` anywhere in the DOM. Only the
detail sheet is instrumented. So rows are addressed by visible name via the `.itin__svc-row` class,
buttons by accessible name, and **the service id is recovered from the write request the UI makes**
— a test cannot pick a service by id up front, because the id is not on the page. Worth a ticket:
adding `data-test="itin-svc-row"` plus `[attr.data-service-id]` would remove the whole class of
brittleness, exactly as `data-traveler-id` does on the roster.

**Assertions stop at the read model.** The traveller suite asserts against make-payable's Postgres
because we have a connection string for it. The equivalent for shopping-gateway needs its own Key
Vault secret (`TripArcShoppingGateway--ConnectionStrings--*`), which QA does not have. Reading back
through `{shopping-inquiry}/trips/{id}/itinerary` proves the service left the read model — it does
**not** prove an integration event was published. Don't let a green run here imply event-level
coverage.

## Status

**Written, not yet run.** No trip has been pointed at it and nothing has been executed, so treat
every case as unproven until it goes green. The readiness wait already avoids the transient-empty
trap that made the traveller suite silently misread a loaded page, but that is a fix carried over by
analogy, not one verified here.

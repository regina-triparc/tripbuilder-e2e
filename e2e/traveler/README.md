# traveler — TB-271 outbound integration-event coverage

Coverage for `TravelerInfoIntegrationEvent`, the event make-payable publishes when a traveler is
**attached to an offer**. Ticket: [TB-271](https://traveledgelab.atlassian.net/browse/TB-271).

```
traveler/
  traveler-info-event.spec.ts   DB invariants over all accumulated events (no browser)
  traveler-info-ui.spec.ts      drives the real Travelers tab, then verifies each layer
  sql/                          the queries, shared with DBeaver and the tb-271-verify CLI
```

Two projects, because they need different things:

```bash
npm run e2e:traveler          # DB-only, ~20s, no browser, no session
npm run e2e:traveler-ui       # drives the portal; add --headed to watch
```

## The three layers the UI suite verifies

Each positive case drives one UI flow and then checks the whole chain:

1. **UI** — the click produced the expected `POST` and it was accepted (202).
2. **Postgres** — the outgoing handler composed and appended the event, stamped
   `integration-direction = Outgoing`, with the right `travelerType` and a real `tripId`.
3. **Service Bus** — the event actually reached the `trip.make-payable` topic with Label
   `trip.make-payable.traveler-info`.

The **event id is the join key** across layers 2 and 3, which is what makes this end-to-end rather
than three observations that merely look consistent: `TravelerInfoOutgoingHandler` mints one GUID and
uses it as both the Marten stream id of the audit append and the `id` field of the published
message, so layer 3 looks up exactly the row layer 2 found.

## Cases

| Case | Flow | Expected |
|---|---|---|
| 1 | attach existing client, "Is travelling" **on** | one `Client` event |
| 2 | add a saved companion | one `Companion` event |
| 3 | add an ad-hoc traveller | one `AdhocTraveller` event |
| 4 | **negative** — turn "Is travelling" **off** on an attached client | **no** traveler-info event |
| 5 | **negative** — attach a client with "Is travelling" **off** | `ClientAssignedToOffer` but **no** traveler-info event |
| 6 | **Remove** a traveller from the offer | `TravelerRemoved` **and no** traveler-info event |
| 7 | create + assign all services → untick **one** service → remove the traveller | `TravelerRemovedFromService` (**serviceId populated**), then `TravelerRemovedFromServices` + `TravelerRemoved`, and **no** traveler-info event |

Case 7 exists because case 6 can never reach the service-level events: a traveller with no
assignments produces only `TravelerRemoved`. The `serviceId` column is what separates the two
removal shapes — **populated** for one cell unticked in the Assignment matrix
(`DELETE …/services/{serviceId}/travellers/{travelerId}`), **null** for the batched event when the
whole traveller goes (`DELETE …/travellers/{travelerId}`). `waitForServiceRemovalEvent` therefore
requires `serviceId IS NOT NULL`, or a whole-traveller removal could masquerade as a single-service
one and the test would pass on the wrong event.

Cases 4 and 6 are both "removal" but are **not interchangeable**. Remove is disabled for the client
row (`item.role === 'client'`), so it only ever applies to companions and ad-hoc travellers; the
client's route out of the pool is the toggle. Case 6 is also the only case with both a positive and
a negative assertion, and it cleans up what case 3 added so repeated runs don't pile test travellers
onto the trip.

Cases 4 and 5 are the only ones that can catch the trigger over-firing; everything else would still
pass if the event fired on every code path. Both deliberately wait out a 30-second quiet window —
an "expect nothing" check that returned immediately would pass while the event was still in flight,
which is exactly the bug it exists to catch.

Case 5 needs a **second** trip (`TB271_FRESH_TRIP_ID`) because a client is locked to an offer once
attached, so case 1 has already claimed the first one.

## Signing in when the tenant has MFA

`auth.setup.ts` (the `setup` project) is unchanged and still the dependency of the `ui` and `api`
projects — it works where Auth0 serves a plain password form. It cannot complete an MFA leg, by
design: a one-time code is only available to the person holding the device.

So there is a second, human-in-the-loop path. It opens a real window, waits for you to sign in, and
writes the same `storageState` file the suites already read — nothing in the specs can tell which
path produced it:

```bash
npm run e2e:auth-manual
```

It never types or reads your credentials; you type into the real Auth0 form yourself. Success is
judged by **calling an authenticated BFF endpoint and requiring HTTP 200**, not by how the page
looks — a rendered avatar only proves the SPA re-rendered, and saving a state file that the BFF
would reject just moves the failure somewhere more confusing. If sign-in doesn't complete, nothing
is written and any existing state file is left alone.

Then run the suites with the dependency skipped, so the unattended setup doesn't overwrite the
session you just created:

```bash
npm run e2e:traveler-ui-manual
```

Sessions expire — the observed lifetime was under 13 days. When tests start failing on a "Sign In"
page (the failure artifacts' `error-context.md` shows it immediately), re-run the manual login.

## Setup

| Env var | Needed for |
|---|---|
| `MAKE_PAYABLE_POSTGRES_URI` | both specs (Key Vault command in `.env.example`) |
| `TBA_E2E_EMAIL` / `TBA_E2E_PASSWORD` | the UI spec — the `setup` project signs in with these |
| `TB271_TRIP_ID` | the UI spec — a dev trip that **already has an offer** |
| `TB271_CLIENT_SEARCH` | which client to attach (default `Cartman`) |
| `TB271_FRESH_TRIP_ID` | case 5 only |
| `MAKE_PAYABLE_SB_NAMESPACE` + `MAKE_PAYABLE_SB_SUBSCRIPTION` | layer 3 |

Everything skips rather than fails when its variable is missing, so `npm run e2e` stays green
off-VPN and in CI.

**Use a trip of your own for `TB271_TRIP_ID`.** The suite adds travelers to it and toggles one off;
pointing it at a colleague's fixture would quietly edit their test data.

The UI suite does **not** create the trip. Doing so means driving search, add-to-quote and the
generate-offer wizard, and then a shopping failure would be indistinguishable from a traveller
failure.

## Layer 3 is not live yet

Service Bus applies subscription filters **at publish time**, so a message matching no rule is
discarded immediately — it is not held anywhere for later inspection. Dev's `trip.make-payable`
topic currently has three subscriptions and none accepts this event:

| Subscription | Rules | Effect on traveler-info |
|---|---|---|
| `travelerassignmentcompletedsubscription` | **none at all** | matches nothing (and is a bug in its own right — booking-gateway's assignment-completed leg gets nothing) |
| `TripManagementSubscription` | 7 Label rules | none for traveler-info |
| `makepayableclientcreatedsubscription` | `$Default 1=1` | receives it, but a live consumer drains it within milliseconds |

So layer 3 needs a QA subscription with the right filter and **no consumer**, which self-deletes
after a week idle:

```bash
az servicebus topic subscription create --resource-group TripArc_TAP_DMX_DEV_Multisource --namespace-name triparc-tripbuilder-shared-sb-01 --topic-name trip.make-payable --name qa-traveler-info-tb271 --default-message-time-to-live P1D --auto-delete-on-idle P7D
```

```bash
az servicebus topic subscription rule create --resource-group TripArc_TAP_DMX_DEV_Multisource --namespace-name triparc-tripbuilder-shared-sb-01 --topic-name trip.make-payable --subscription-name qa-traveler-info-tb271 --name TravelerInfoOnly --filter-type CorrelationFilter --label trip.make-payable.traveler-info
```

```bash
az servicebus topic subscription rule delete --resource-group TripArc_TAP_DMX_DEV_Multisource --namespace-name triparc-tripbuilder-shared-sb-01 --topic-name trip.make-payable --subscription-name qa-traveler-info-tb271 --name '$Default'
```

Add the Label rule **before** deleting `$Default`, so the subscription is never in a state where it
matches nothing — that is very likely how `travelerassignmentcompletedsubscription` ended up dead.
And use `--label`, not `--correlation-filter label=…`: the latter writes a custom property and
creates a rule that silently matches nothing.

Then set `MAKE_PAYABLE_SB_SUBSCRIPTION=qa-traveler-info-tb271` and layer 3 switches on. Filters only
apply to messages published *after* the subscription exists, so create it before running the suite.

Peeking needs the **Azure Service Bus Data Receiver** role on the namespace. The helper reports a
missing role and a missing subscription as skips with a reason, not failures, so an infrastructure
gap never reads as a product defect.

The suite only ever calls `peekMessages()`, never `receiveMessages()` — peek leaves messages in
place and does not touch delivery count, so running it cannot consume a message a real subscriber
was waiting for.

## Property-spelling inconsistency in the audit stream (worth raising)

The assignment events carry **both spellings of the traveller id**, so a query or consumer reading
one silently gets null for the other:

| Event | `travelerId` (one L) | `travellerId` (two Ls) |
|---|---|---|
| `TravelerAssignedToServiceIntegrationEvent` | 47 | **55** |
| `TravelerAssignedToServicesIntegrationEvent` | 105 | **86** |
| `TravelerInfoIntegrationEvent` | 126 | 0 |
| `TravelerRemoved*` | all | 0 |

The rename (`refactor(make-payable): normalize traveler property spelling on 3 outbound integration
events`) changed the wire shape **without a version bump or a `[MessageIdentity]` change**, so
pre-rename events in the stream still use the old key. Traveler-info — TB-271's actual subject —
is unaffected, but anything replaying the assignment events needs to read both. Scripts 11 and 12
and the DB helpers use `COALESCE(data ->> 'travelerId', data ->> 'travellerId')` for exactly this
reason. Row counts are from an ad-hoc audit on 2026-09-10 and are indicative rather than exact.

## Failure artifacts

Nothing is attached on a passing run — the specs already attach the positive evidence (the HTTP
call, the audit event) unconditionally, and artifact noise on green makes a report harder to read.

On failure, `traveler-ui` produces:

| Artifact | Source |
|---|---|
| `video.webm` | Playwright, `retain-on-failure`, 1280×720 |
| `test-failed-1.png` | Playwright, `only-on-failure` |
| `trace.zip` | Playwright, `retain-on-failure`, with screenshots + snapshots (sources off to keep it small enough to attach to a ticket) |
| `sql-trace.txt` | every query the test ran — SQL, bound params, row counts, timings |
| `repro.sh` | the make-payable call as runnable curl, cookie reconstructed from `storageState`, with the `X-Csrf` header the BFF demands |
| `rerun.txt` | `tb-271-verify` / DBeaver commands for the same offer, plus how to read the timeline |
| `artifacts-index.txt` | which artifacts were configured, and the `show-trace` command with the real path |

The DB-only `traveler` project has video, screenshot and trace **off on purpose** — it launches no
browser, so those files would be empty, and an empty artifact folder invites someone to hunt for a
config bug that isn't there. Its failure evidence is `sql-trace.txt` plus `rerun.txt`, and the offer
id in `rerun.txt` is recovered from the bound query parameters since that spec has no HTTP call.

Open a trace with:

```bash
npx playwright show-trace test-artifacts/<test-dir>/trace.zip
```

Verified on 2026-09-10 by forcing failures in both projects: the DB project attached the SQL trace
(with the failing offer id and a 0-row result) and the rerun hints; the UI project produced a 19KB
screenshot, a 656KB video and a 1MB trace alongside them. Two things that came out of checking
rather than assuming — video and trace are attached by Playwright **after** `afterEach` hooks run,
so an index written in the hook cannot list them (it reports the configured modes instead), and the
`list` reporter prints only the first few lines of an inline attachment, so `artifacts-index.txt`
leads with the artifact modes and the `show-trace` command.

## Why the queries live in `.sql` files

The same files are read by these specs, opened directly in DBeaver, and executed by the standalone
`tb-271-verify` CLI in `Documents\tb-271-verify`. One source of truth on purpose: a verification
query that has drifted into three copies is worse than none, because a stale copy that still passes
looks like coverage. `03`, `04`, `05` use DBeaver's `:offer_id` named parameter, which
`utils/make-payable-db.ts` rewrites to pg's `$1` and binds properly, so the files stay runnable by
hand without editing.

## Verified live on 2026-09-10

Case 3 was walked by hand through the real dev portal before the automation was trusted, and the
POM was corrected against what actually happened. Evidence:

- `POST /bff/api/make-payable-management/offers/f7ce40ff-…/travellers/new` → **200**
- event `bc90b2c1-27ef-4283-89e9-0b9467c10de9` appended ~6s later, `direction = Outgoing`
- payload: `travelerType = AdhocTraveller`, name/phone as typed, `nodeId`/`status`/`dateOfBirth`
  null as designed, and `tripId = 9b93052b-…` — the real trip, **not** the all-zero leak

Removal (case 6) was then walked the same way, on the same traveller:

- `DELETE /bff/api/make-payable-management/offers/f7ce40ff-…/travellers/e8213423-…` → **200**
- `TravelerRemovedIntegrationEvent` at 12:11:16Z, `direction = Outgoing`
- **no** new traveler-info event — still only `bc90b2c1` from the attach
- only `TravelerRemoved` fired, **not** `TravelerRemovedFromService(s)`, because that traveller had
  0 assigned services. The helper therefore requires only the former; demanding the service-level
  event would fail correct behaviour.

Five things that run corrected, each of which would have made a green suite meaningless:

1. **The route.** The `/trips` dashboard navigates to `/tsp/:tripId/travellers` (apps/tsp), not
   `/trips/:tripId/travelers` (apps/trip). Both exist, the spelling differs by one L, and the wrong
   one renders a **blank page with no error** — a test would have timed out looking for selectors on
   an empty document. The POM now takes an app variant and defaults to `tsp`.
2. **The status code.** `/travellers/new` returned **200**, not the documented 202. Asserting 202
   alone would have failed a working flow.
3. **Checkbox state is not readable from the accessibility tree.** Both checkboxes report
   `value="on"` whether ticked or not, so a snapshot shows `checkbox "on"` for an unchecked box.
   Confirmed via the DOM `.checked` property that "save as a companion" defaults to **unchecked**,
   which is what puts the manual form on the ad-hoc path. The POM now asserts this rather than
   assuming it — if that default ever flips, case 3 would silently start testing the Companion path
   while still claiming ad-hoc coverage.
4. **Removal is a `DELETE`, not a `POST`.** The POM's capture helper matched only `POST`, so it
   would never have seen a removal call — the test would have hung to timeout with no useful
   message. It now takes an explicit method list.
5. **Case 2's skip is legitimate.** The sheet showed "No saved contacts on this profile yet"
   (`ats-no-companions`), matching `companions: []` in the read model. The skip reflects test data,
   not a product defect.

Case 1 could not be re-run on that trip because a client is locked to an offer once attached — it
already had TEST TEST. Point `TB271_TRIP_ID` at a trip with no client for a full run.

**Possible unrelated defect, worth checking:** the `/trips` dashboard listed **every** trip with
Client `—`, including this one, which demonstrably has TEST TEST attached as a travelling client.
Either that column reads from a different source than make-payable's roster, or it is not being
populated.

## Selector note

The traveller components use `data-test`, **not** `data-testid` (only the generate-offer wizard uses
the latter). Both sheets are two-step, and the commit is the *second* button: `acs-done` for attach
client, `ats-done` for add traveller. `acs-attach-and-assign` merely advances the step — a test that
asserts after clicking it will find nothing. "Is travelling" defaults to **true**
(`travelers-roster.store.ts`), so the negative cases actively uncheck it.

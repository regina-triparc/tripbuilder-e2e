-- TB-271 / 12 — Service-level assignment and removal events for one offer.
--
-- Three shapes, and the `serviceId` column is what tells them apart:
--
--   TravelerRemovedFromServiceIntegrationEvent    serviceId POPULATED
--       one service unticked in the Assignment matrix
--       DELETE {management}/offers/{o}/services/{serviceId}/travellers/{t}
--
--   TravelerRemovedFromServicesIntegrationEvent   serviceId NULL (batched)
--       the traveller was removed from the offer, so every assignment went at once
--       DELETE {management}/offers/{o}/travellers/{t}
--
--   TravelerAssignedToServicesIntegrationEvent    serviceId NULL (batched)
--       POST {management}/offers/{o}/travellers/{t}/services with a serviceIds[]
--
-- Verified against a real session's HAR on 2026-09-10 (offer 4de437b6-…):
--   13:00:36Z  TravelerInfo + TravelerAssignedToServices   (one "Done" click: create + assign 12)
--   13:00:54Z  TravelerRemovedFromService  serviceId 61604f35-…   (one cell unticked)
--   13:01:06Z  TravelerRemovedFromServices + TravelerRemoved      (traveller removed)
--
-- Note on the batched shape: it has no `serviceId`, but it DOES carry a
-- `serviceIds` array (payload keys: id, offerId, serviceIds, travelerId, tripId),
-- so a subscriber can still tell which services were unassigned. The `serviceId`
-- column below is null for it simply because the field is named differently —
-- that is not a missing-data defect.

SELECT timestamp,
       COALESCE(substring(mt_dotnet_type from '([^.,]+)(?:,|$)'), mt_dotnet_type) AS event_type,
       COALESCE(data ->> 'travelerId', data ->> 'travellerId') AS traveler_id,
       data ->> 'serviceId'  AS service_id,
       CASE WHEN data ->> 'serviceId' IS NOT NULL THEN 'single'
            WHEN mt_dotnet_type LIKE '%Services%'  THEN 'batched'
            ELSE '-' END AS shape,
       headers ->> 'integration-direction' AS direction,
       causation_id
FROM integration_schema.mt_events
WHERE data ->> 'offerId' = :offer_id
  AND (mt_dotnet_type LIKE '%TravelerAssignedToService%'
    OR mt_dotnet_type LIKE '%TravelerRemovedFromService%')
ORDER BY timestamp;

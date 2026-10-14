-- TB-271 / 11 — Removal-side events for one offer.
--
-- Two UI paths remove a traveller, and they are NOT interchangeable:
--   Remove button        DELETE {management}/offers/{offerId}/travellers/{travelerId}
--                        disabled for the client row, so companions/ad-hoc only
--   "Is travelling" off  the client's route out of the traveller pool
--
-- Expect after a removal:
--   TravelerRemovedIntegrationEvent              always
--   TravelerRemovedFromService(s)IntegrationEvent only if the traveller had
--                                                 service assignments to undo
--   NO new TravelerInfoIntegrationEvent          traveler-info is attach-only
--
-- Verified in dev 2026-09-10: removing an ad-hoc traveller with 0 assigned
-- services produced TravelerRemoved alone, and no traveler-info event.

SELECT timestamp,
       COALESCE(substring(mt_dotnet_type from '([^.,]+)(?:,|$)'), mt_dotnet_type) AS event_type,
       headers ->> 'integration-direction' AS direction,
       COALESCE(data ->> 'travelerId', data ->> 'travellerId') AS traveler_id,
       data ->> 'serviceId'  AS service_id,
       causation_id
FROM integration_schema.mt_events
WHERE data ->> 'offerId' = :offer_id
  AND (mt_dotnet_type LIKE '%TravelerRemoved%'
    OR mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%')
ORDER BY timestamp;

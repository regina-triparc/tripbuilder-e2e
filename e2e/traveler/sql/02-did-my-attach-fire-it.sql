-- TB-271 / 02 — Did the traveler I just attached in the UI produce an event?
--
-- Run within a few minutes of clicking. Expect one new row per traveler attached, within seconds.
-- Nothing here? Go to 04 with the offer id: if ClientAssignedToOffer is present but traveler-info
-- is not, Management published the trigger and Integration.Worker never consumed it.

SELECT timestamp,
       data ->> 'travelerType' AS traveler_type,
       data ->> 'offerId'      AS offer_id,
       data ->> 'tripId'       AS trip_id,
       data ->> 'travelerId'   AS traveler_id,
       concat_ws(' ', data ->> 'firstName', data ->> 'lastName') AS name,
       correlation_id,
       causation_id
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
  AND timestamp > now() - interval '15 minutes'
ORDER BY timestamp DESC;

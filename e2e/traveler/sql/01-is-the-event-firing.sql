-- TB-271 / 01 — Is the event firing, and for which traveler types?
--
-- Run this first every session: it also proves you are on the right database.
-- Expect: three rows (Client / Companion / AdhocTraveller), zero_trip_id = 0 on all of them.
-- No rows at all  -> wrong database (or the event has never fired), not necessarily a bug.
-- zero_trip_id > 0 -> the TODO(TB-271) TripId leak has become reachable. That IS a defect.

SELECT data ->> 'travelerType' AS traveler_type,
       count(*)                AS total,
       count(*) FILTER (WHERE data ->> 'tripId' = '00000000-0000-0000-0000-000000000000') AS zero_trip_id,
       min(timestamp)          AS earliest,
       max(timestamp)          AS latest
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
GROUP BY 1
ORDER BY 1;

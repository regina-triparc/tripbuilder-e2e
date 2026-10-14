-- TB-271 / 04 — Everything that happened on one offer, in order. The main diagnostic.
--
-- How to read it:
--   traveler-info present                              -> the whole chain worked
--   ClientAssignedToOffer present, traveler-info absent -> Management published the trigger and
--                                                          Integration.Worker never consumed it.
--                                                          Broken outgoing leg, not a UI problem.
--   nothing at all                                      -> the command never reached Management
--   direction <> 'Outgoing'                             -> audit header contract broken

SELECT timestamp,
       COALESCE(substring(mt_dotnet_type from '([^.,]+)(?:,|$)'), mt_dotnet_type) AS event_type,
       headers ->> 'integration-direction' AS direction,
       correlation_id,
       causation_id
FROM integration_schema.mt_events
WHERE data ->> 'offerId' = :offer_id
ORDER BY timestamp;

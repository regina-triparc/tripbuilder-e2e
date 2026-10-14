-- TB-271 / 06 — Repeat events: real duplicate-publish bug, or just a re-attach?
--
-- The contract is "one event per offer-traveler attachment", so repeats look alarming. Read them
-- with causation_id, NOT correlation_id:
--
--   distinct_causations = events -> that many distinct commands. Someone attached, removed and
--                                   re-attached (or the API was retried). NOT a bug.
--   distinct_causations = 1      -> ONE command published the event repeatedly.
--                                   IDEMPOTENCY BUG. Raise it with this row attached.
--
-- distinct_correlations = 1 is EXPECTED even across many commands: the handler deliberately
-- preserves the aggregate's CorrelationId once the stream exists. Shared correlation is not
-- evidence of duplication.

SELECT data ->> 'offerId'      AS offer_id,
       data ->> 'travelerId'   AS traveler_id,
       data ->> 'travelerType' AS traveler_type,
       concat_ws(' ', data ->> 'firstName', data ->> 'lastName') AS name,
       count(*)                        AS events,
       count(DISTINCT causation_id)    AS distinct_causations,
       count(DISTINCT correlation_id)  AS distinct_correlations,
       max(timestamp) - min(timestamp) AS spread
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
ORDER BY count(*) DESC, 8;

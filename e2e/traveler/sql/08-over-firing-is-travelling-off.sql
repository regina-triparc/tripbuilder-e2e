-- TB-271 / 08 — Over-firing check: "Is Travelling" OFF must NOT emit a traveler-info event.
--
-- ClientAssignedToOffer fires on EVERY client attach. traveler-info fires only when the client
-- actually joined the traveller pool. So the negative test case is:
--   1. fresh offer, attach a client with "Is Travelling" OFF
--   2. run this
--   3. that offer must appear under 'client-assigned only'
-- If it appears under 'both', the trigger is over-firing. That is a defect.
--
-- 'traveler-info only' rows are usually a deploy-window artifact rather than a gap: traveler-info
-- began publishing 2 Sep 14:55, ClientAssignedToOffer only from 3 Sep 15:39. Check timestamps in
-- script 02 before calling one a bug.

WITH assigned AS (
    SELECT DISTINCT data ->> 'offerId' AS offer_id
    FROM integration_schema.mt_events
    WHERE mt_dotnet_type LIKE '%ClientAssignedToOfferIntegrationEvent%'
),
info AS (
    SELECT DISTINCT data ->> 'offerId' AS offer_id
    FROM integration_schema.mt_events
    WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
      AND data ->> 'travelerType' = 'Client'
)
SELECT CASE WHEN a.offer_id IS NOT NULL AND i.offer_id IS NOT NULL
                 THEN 'both (client attached AS traveller)'
            WHEN a.offer_id IS NOT NULL
                 THEN 'client-assigned only (Is Travelling OFF - expected)'
            ELSE 'traveler-info only (check deploy window first)' END AS shape,
       count(*) AS offers
FROM assigned a
FULL OUTER JOIN info i ON i.offer_id = a.offer_id
GROUP BY 1
ORDER BY 2 DESC;

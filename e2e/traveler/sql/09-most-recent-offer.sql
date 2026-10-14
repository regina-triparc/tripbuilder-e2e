-- TB-271 / 09 — Which offer most recently produced a traveler-info event?
--
-- Used by traveler-info-event.spec.ts to pick a subject for the payload check
-- when TB271_OFFER_ID is not pinned. Also handy by hand: the fastest way to
-- get an offer id to feed scripts 03, 04 and 05 without digging through the
-- browser's Network tab.

SELECT data ->> 'offerId' AS offer_id,
       max(timestamp)     AS latest,
       count(*)           AS events
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 1;

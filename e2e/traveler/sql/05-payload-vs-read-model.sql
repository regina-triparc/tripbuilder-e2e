-- TB-271 / 05 — Does the event carry the RIGHT data, not just any data?
--
-- Compares each traveler-info payload against the client read model field by field. This is the
-- check that makes the test meaningful: an event that exists but carries the wrong name is a bug.
--
-- Expect 'match' on every row.
-- 'no read model row' is CORRECT for an AdhocTraveller (it has no ACAVE persona, so no nodeId).
-- Anything ending in 'differs' is a defect worth raising with the payload attached.

WITH ev AS (
    SELECT timestamp,
           data ->> 'travelerType' AS traveler_type,
           data ->> 'nodeId'       AS node_id,
           data ->> 'firstName'    AS ev_first,
           data ->> 'lastName'     AS ev_last,
           data ->> 'email'        AS ev_email,
           data ->> 'phoneNumber'  AS ev_phone,
           data ->> 'status'       AS ev_status
    FROM integration_schema.mt_events
    WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
      AND data ->> 'offerId' = :offer_id
),
rm AS (
    -- top-level clients
    SELECT data ->> 'nodeId'      AS node_id,
           data ->> 'firstName'   AS rm_first,
           data ->> 'lastName'    AS rm_last,
           data ->> 'email'       AS rm_email,
           data ->> 'phoneNumber' AS rm_phone,
           data ->> 'status'      AS rm_status
    FROM inquiry_schema.mt_doc_clientreadmodel
    UNION ALL
    -- companions are nested inside the client document, not rows of their own
    SELECT comp ->> 'nodeId', comp ->> 'firstName', comp ->> 'lastName',
           comp ->> 'email', comp ->> 'phoneNumber', comp ->> 'status'
    FROM inquiry_schema.mt_doc_clientreadmodel d
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.data -> 'companions', '[]'::jsonb)) AS comp
)
SELECT ev.traveler_type,
       ev.node_id,
       CASE WHEN rm.node_id IS NULL                        THEN 'no read model row'
            WHEN ev.ev_first  IS DISTINCT FROM rm.rm_first  THEN 'firstName differs'
            WHEN ev.ev_last   IS DISTINCT FROM rm.rm_last   THEN 'lastName differs'
            WHEN ev.ev_email  IS DISTINCT FROM rm.rm_email  THEN 'email differs'
            WHEN ev.ev_phone  IS DISTINCT FROM rm.rm_phone  THEN 'phoneNumber differs'
            WHEN ev.ev_status IS DISTINCT FROM rm.rm_status THEN 'status differs'
            ELSE 'match' END AS verdict,
       concat_ws(' / ', ev.ev_first, ev.ev_last) AS event_name,
       concat_ws(' / ', rm.rm_first, rm.rm_last) AS read_model_name,
       ev.ev_email  AS event_email,
       rm.rm_email  AS read_model_email
FROM ev
LEFT JOIN rm ON rm.node_id = ev.node_id
ORDER BY ev.timestamp;

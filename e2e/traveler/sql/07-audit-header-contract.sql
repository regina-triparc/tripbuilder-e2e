-- TB-271 / 07 — Audit-header contract.
--
-- Every outgoing integration event must be stamped integration-direction = Outgoing when it is
-- appended, so the audit stream can be told apart from inbound events sharing the same table.
--
-- Expect exactly one row: Outgoing = <total>.
-- Any '(header missing)' row is a defect in TravelerInfoOutgoingHandler.

SELECT COALESCE(headers ->> 'integration-direction', '(header missing)') AS direction,
       count(*) AS rows
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
GROUP BY 1
ORDER BY 2 DESC;

-- TB-271 / 03 — Full event payload for one offer.
--
-- DBeaver prompts for :offer_id when you execute (Ctrl+Enter). Paste the GUID from the
-- POST /offers/{offerId}/... call in the browser's Network tab.
--
-- Expected field pattern per traveler type — blanks below are BY DESIGN, not defects:
--   Client          nodeId + agentNodeId + address, but no clientNodeId and no relationship*
--   Companion       nodeId + clientNodeId + relationshipTo/From; NO address
--   AdhocTraveller  firstName/lastName/phoneNumber only; no nodeId, status, dateOfBirth, gender
--   passport        null for everyone today (present for shape symmetry only)

SELECT timestamp,
       jsonb_pretty(data) AS payload
FROM integration_schema.mt_events
WHERE mt_dotnet_type LIKE '%TravelerInfoIntegrationEvent%'
  AND data ->> 'offerId' = :offer_id
ORDER BY timestamp;

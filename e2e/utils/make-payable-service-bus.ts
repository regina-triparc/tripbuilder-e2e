import { ServiceBusClient, type ServiceBusReceivedMessage } from '@azure/service-bus';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * PEEK-ONLY access to the `trip.make-payable` Service Bus topic, to prove the
 * last hop of TB-271: make-payable does not merely append the event to its
 * audit stream, it actually publishes it to the broker with the right Label.
 *
 * WHY THIS SKIPS TODAY. Service Bus evaluates subscription filters at publish
 * time, so a message matching no rule is discarded immediately — it is not
 * queued anywhere for later inspection. Dev's topic currently has three
 * subscriptions and none filters on `trip.make-payable.traveler-info`:
 *
 *   travelerassignmentcompletedsubscription   no rules at all (matches nothing)
 *   TripManagementSubscription                7 Label rules, none for traveler-info
 *   makepayableclientcreatedsubscription      $Default 1=1 catch-all, but a live
 *                                             consumer drains it within ms
 *
 * So these checks need a QA subscription with the right Label filter and NO
 * consumer attached, which is why everything here degrades to a skip instead
 * of a failure until MAKE_PAYABLE_SB_SUBSCRIPTION exists. Creation commands are
 * in traveler/README.md.
 *
 * PEEK, NEVER RECEIVE. peekMessages() leaves messages in place and does not
 * increment delivery count, so running this suite cannot consume a message a
 * real subscriber was waiting for. receiveMessages() would; never use it here,
 * even in "peek lock" mode, because an abandoned lock still bumps the delivery
 * count and can push a message toward the dead-letter queue.
 *
 * Auth is DefaultAzureCredential, so a developer already signed in with
 * `az login` needs no secrets — but the identity does need the
 * **Azure Service Bus Data Receiver** role on the namespace. Without it the
 * SDK raises an authorization error, which is reported as a skip-worthy
 * configuration problem rather than a product defect.
 */

export const TRAVELER_INFO_LABEL = 'trip.make-payable.traveler-info';
const TOPIC = 'trip.make-payable';

let client: ServiceBusClient | undefined;

export function isServiceBusConfigured(): boolean {
  return Boolean(process.env.MAKE_PAYABLE_SB_NAMESPACE && process.env.MAKE_PAYABLE_SB_SUBSCRIPTION);
}

function getClient(): ServiceBusClient {
  if (!client) {
    const namespace = process.env.MAKE_PAYABLE_SB_NAMESPACE;
    if (!namespace) {
      throw new Error('MAKE_PAYABLE_SB_NAMESPACE is not set — call isServiceBusConfigured() first.');
    }
    // Accepts either a bare name or a full FQDN, since both spellings appear in
    // the portal and in our own docs.
    const fqdn = namespace.includes('.') ? namespace : `${namespace}.servicebus.windows.net`;
    client = new ServiceBusClient(fqdn, new DefaultAzureCredential());
  }
  return client;
}

/** Call once from Playwright globalTeardown so the AMQP connection closes. */
export async function closeServiceBusConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
  }
}

export interface PeekOutcome {
  /** false when the subscription/role is missing — the caller should skip, not fail. */
  usable: boolean;
  reason?: string;
  messages: ServiceBusReceivedMessage[];
}

/**
 * Peeks from the start of the QA subscription. `fromSequenceNumber: 0` matters:
 * without it, repeated peeks advance an internal cursor and a second call in the
 * same run silently returns nothing, which reads exactly like "the event was
 * never published".
 */
export async function peekTravelerInfoMessages(maxMessages = 50): Promise<PeekOutcome> {
  if (!isServiceBusConfigured()) {
    return { usable: false, reason: 'MAKE_PAYABLE_SB_NAMESPACE / MAKE_PAYABLE_SB_SUBSCRIPTION not set', messages: [] };
  }

  const subscription = process.env.MAKE_PAYABLE_SB_SUBSCRIPTION!;
  let receiver;
  try {
    receiver = getClient().createReceiver(TOPIC, subscription);
    const messages = await receiver.peekMessages(maxMessages, { fromSequenceNumber: 0n });
    return { usable: true, messages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string })?.code ?? '';

    // Distinguish "not provisioned yet" and "no RBAC" (both expected today,
    // both a skip) from a genuine broker problem (worth failing on).
    if (/MessagingEntityNotFound|not be found/i.test(message) || code === 'MessagingEntityNotFound') {
      return { usable: false, reason: `subscription "${subscription}" does not exist on ${TOPIC} yet`, messages: [] };
    }
    if (/Unauthorized|authorization|claims/i.test(message)) {
      return {
        usable: false,
        reason: `not authorized to peek ${TOPIC}/${subscription} — needs the Azure Service Bus Data Receiver role`,
        messages: [],
      };
    }
    throw err;
  } finally {
    await receiver?.close();
  }
}

/**
 * Polls the subscription for a message whose body carries this event id. The
 * event id is the join key between the two systems: the same GUID is the
 * Marten stream id of the audit append AND the `id` field of the published
 * event (TravelerInfoOutgoingHandler mints it once and uses it for both). That
 * makes this a genuine end-to-end assertion rather than two independent
 * observations that happen to look similar.
 */
export async function waitForPublishedEvent(
  eventId: string,
  timeoutMs = 60_000,
): Promise<{ found: ServiceBusReceivedMessage | undefined; outcome: PeekOutcome }> {
  const deadline = Date.now() + timeoutMs;
  let outcome: PeekOutcome = { usable: false, messages: [] };

  while (Date.now() < deadline) {
    outcome = await peekTravelerInfoMessages();
    if (!outcome.usable) return { found: undefined, outcome };

    const found = outcome.messages.find((message) => {
      const body = message.body as { id?: string } | undefined;
      return body?.id?.toLowerCase() === eventId.toLowerCase();
    });
    if (found) return { found, outcome };

    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return { found: undefined, outcome };
}

/**
 * Contract checks on a published message. The Label (ASB Subject) is the part
 * that actually matters operationally: subscribers route on it via
 * CorrelationFilter, so a wrong or missing Label means every subscription
 * silently ignores the event even though the publish "succeeded".
 */
export function assertPublishedMessageShape(
  message: ServiceBusReceivedMessage,
  expected: { eventId: string; offerId: string; travelerType: string },
): string[] {
  const failures: string[] = [];
  const body = message.body as Record<string, unknown> | undefined;

  if (message.subject !== TRAVELER_INFO_LABEL) {
    failures.push(`asb: Label/Subject is "${message.subject}", expected "${TRAVELER_INFO_LABEL}"`);
  }
  if (String(body?.id).toLowerCase() !== expected.eventId.toLowerCase()) {
    failures.push(`asb: body.id is "${String(body?.id)}", expected the audit event id "${expected.eventId}"`);
  }
  if (String(body?.offerId).toLowerCase() !== expected.offerId.toLowerCase()) {
    failures.push(`asb: body.offerId is "${String(body?.offerId)}", expected "${expected.offerId}"`);
  }
  if (String(body?.travelerType) !== expected.travelerType) {
    failures.push(`asb: body.travelerType is "${String(body?.travelerType)}", expected "${expected.travelerType}"`);
  }
  if ((message.deliveryCount ?? 0) > 0) {
    failures.push(
      `asb: deliveryCount is ${message.deliveryCount} — something is consuming or abandoning messages on ` +
        'the QA subscription; it should have no consumer attached',
    );
  }
  return failures;
}

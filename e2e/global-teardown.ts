import { closePimDbConnection } from './utils/pim-db';
import { closeMakePayableDbConnection } from './utils/make-payable-db';
import { closeServiceBusConnection } from './utils/make-payable-service-bus';

export default async function globalTeardown(): Promise<void> {
  await closePimDbConnection();
  await closeMakePayableDbConnection();
  await closeServiceBusConnection();
}

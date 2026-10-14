import { generateLiveInventoryDataset } from './utils/live-inventory';
import { fetchLiveFacetGroundTruth } from './utils/live-facet-ground-truth';
import { generateNegativeFacetDataset } from './utils/generate-negative-facet-dataset';

export default async function globalSetup(): Promise<void> {
  await generateLiveInventoryDataset();

  const groundTruth = await fetchLiveFacetGroundTruth();
  if (!groundTruth) {
    console.warn('[live-inventory] PIM_MONGODB_URI not set — skipping negative-facet dataset refresh, keeping existing fixture on disk.');
    return;
  }
  generateNegativeFacetDataset(groundTruth);
}

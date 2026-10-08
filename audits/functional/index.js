import { notImplemented } from '../_shared.js';

export const meta = { category: 'functional', runners: [], description: 'Storefront journeys (add to cart, cart drawer, checkout up to payment, widget capture). Not implemented yet.' };

export async function run() {
  return notImplemented('No generic storefront-journey runner exists yet. The Integrity widget capture also needs the storefront password, which must be entered by a person.');
}

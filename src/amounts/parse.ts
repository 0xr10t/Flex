// Implements: §8.4 step 3 code parser (signature only at contracts-v1).
// Owner: Lane B. Other lanes import parseAmountText from here and mock it in their tests until Lane B merges.

import type { ParseAmountText } from '../contracts/step.js';

export const parseAmountText: ParseAmountText = () => {
  throw new Error('parseAmountText: not implemented until Lane B merges');
};

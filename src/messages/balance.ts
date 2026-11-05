// Implements: §13.2 balance answer (signature only at contracts-v1).
// Owner: Lane D. Lane B's S4 imports buildBalanceAnswer from here and mocks it in tests until Lane D merges.

import type { BuildBalanceAnswer } from '../contracts/step.js';

export const buildBalanceAnswer: BuildBalanceAnswer = () => {
  throw new Error('buildBalanceAnswer: not implemented until Lane D merges');
};

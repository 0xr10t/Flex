// SQ-M-01: select a live model explicitly without changing deterministic fixtures or the comparison oracle.
import type { Config } from '../../src/contracts/types.js';

export function liveModelConfig(base: Config['llm'], env: NodeJS.ProcessEnv = process.env): Config['llm'] {
  const llm = { ...base };
  if (env.LIVE_MODEL !== undefined) {
    const model = env.LIVE_MODEL.trim();
    if (!model) throw new Error('LIVE_MODEL must name a local Ollama model');
    llm.model = model;
  }
  if (env.LIVE_THINK !== undefined) {
    if (env.LIVE_THINK !== 'true' && env.LIVE_THINK !== 'false') {
      throw new Error('LIVE_THINK must be true or false');
    }
    llm.think = env.LIVE_THINK === 'true';
  }
  return llm;
}

/** Enable the production chat profile explicitly; an omitted flag preserves the historical wallet-only run. */
export function liveChatConfig(base: Config['chat'], env: NodeJS.ProcessEnv = process.env): Config['chat'] {
  if (env.LIVE_CHAT === undefined) return base === undefined ? undefined : { ...base };
  if (env.LIVE_CHAT !== 'true' && env.LIVE_CHAT !== 'false') {
    throw new Error('LIVE_CHAT must be true or false');
  }
  return { enabled: env.LIVE_CHAT === 'true', think: true };
}

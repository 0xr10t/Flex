import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Config } from '../../contracts/types.js';
import {
  checkCancelled,
  ensureProcess,
  probeHttp,
  requestSignal,
  responseObject,
  ServiceStartError,
  type ServiceOptions,
  type Readiness,
} from './process.js';

export interface OllamaOptions extends ServiceOptions {
  executable?: string;
  modelTimeoutMs?: number;
}

function executable(override?: string): string {
  const name = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  const explicit = override ?? process.env.FLEX_OLLAMA_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, name)),
        '/opt/homebrew/bin/ollama',
        '/usr/local/bin/ollama',
        '/Applications/Ollama.app/Contents/Resources/ollama',
      ];
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next installation. */
    }
  }
  throw new ServiceStartError(
    'ollama',
    'Install Ollama, or set FLEX_OLLAMA_PATH to its executable, then reopen flexx.',
  );
}

/** Start the local daemon, download missing configured models, and verify that each model loads. */
export async function ensureOllama(config: Config, opts: OllamaOptions = {}) {
  const base = config.llm.ollama_url.replace(/\/+$/, '');
  let models: Array<{ name?: string; model?: string }> = [];
  const probe = async (): Promise<Readiness> => {
    const response = await probeHttp(`${base}/api/tags`, opts);
    if (typeof response === 'string') return response;
    if (response.status === 503) return 'waiting';
    const body = await responseObject(response);
    if (!response.ok || !Array.isArray(body?.models))
      throw new ServiceStartError(
        'ollama',
        'The configured Ollama address is occupied by an incompatible service. Check OLLAMA_URL.',
      );
    models = body.models.filter((model) => model !== null && typeof model === 'object');
    return 'ready';
  };
  opts.onStatus?.('Checking Ollama...');
  const handle = await ensureProcess(
    {
      service: 'ollama',
      label: 'Ollama',
      probe,
      command: () => ({
        executable: executable(opts.executable),
        args: ['serve'],
        options: { detached: true, env: { ...process.env, OLLAMA_HOST: new URL(base).host, OLLAMA_NO_CLOUD: 'true' } },
      }),
      failure: 'Ollama did not become ready. Check the installation and available memory, then reopen flexx.',
    },
    opts,
  );
  try {
    const wanted = [
      ...new Set([...(config.chat?.enabled && config.chat.model ? [config.chat.model] : []), config.llm.model]),
    ];
    for (const model of wanted) {
      checkCancelled(opts.signal);
      if (!models.some((m) => m.name === model || m.model === model || m.name === `${model}:latest`)) {
        opts.onStatus?.(`Downloading ${model}; the first download can take several minutes...`);
        const response = await (opts.fetchImpl ?? fetch)(`${base}/api/pull`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, stream: false }),
          signal: requestSignal(opts.signal, opts.modelTimeoutMs ?? 30 * 60_000),
        });
        const result = await responseObject(response);
        if (!response.ok || result?.status !== 'success')
          throw new ServiceStartError(
            'ollama',
            `Could not download ${model}. Check the model name, connection and free disk space, then retry.`,
          );
      }
      opts.onStatus?.(`Loading ${model}...`);
      const response = await (opts.fetchImpl ?? fetch)(`${base}/api/generate`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: '',
          stream: false,
          keep_alive: '30m',
          options: { num_ctx: config.llm.num_ctx },
        }),
        signal: requestSignal(opts.signal, opts.modelTimeoutMs ?? 5 * 60_000),
      });
      const result = await responseObject(response);
      if (!response.ok || result?.done !== true || result.error)
        throw new ServiceStartError(
          'ollama',
          `Ollama could not load ${model}. Check available memory and the model installation, then retry.`,
        );
    }
    checkCancelled(opts.signal);
    opts.onStatus?.('Ollama and the configured models are ready.');
    return handle;
  } catch (error) {
    handle.stop();
    checkCancelled(opts.signal);
    throw error instanceof ServiceStartError
      ? error
      : new ServiceStartError('ollama', 'The model startup did not finish. Check Ollama and retry.');
  }
}

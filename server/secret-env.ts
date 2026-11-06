// Segredos do próprio Habblaud que vêm por variável de ambiente: nunca vão para um processo filho (agentes, portão,
// QA, terminal, hooks do git, resumo). Os agentes rodam com o mesmo usuário do sistema, então isto só fecha o caminho
// do env; o que fica em <dataDir> eles ainda conseguem ler (por isso o token do GitHub deve ser fine-grained e restrito).
export const SECRET_ENV_VARS = [
  'HABBLAUD_GITHUB_TOKEN',
  'HABBLAUD_VBOARDS_TOKEN',
  'HABBLAUD_REMOTE_PASSWORD',
  'HABBLAUD_REMOTE_PASSWORD_HASH',
  'HABBLAUD_OPENAI_API_KEY',
  'HABBLAUD_GEMINI_API_KEY',
] as const;

/** Cópia do env sem os segredos do Habblaud (o resto fica igual). */
export function withoutSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SECRET_ENV_VARS) delete out[k];
  return out;
}

/**
 * Depois que a partida leu a configuração: tira os segredos do process.env (o que herda o env sem passar por
 * withoutSecrets também fica limpo) e devolve os valores para quem precisa deles.
 */
export function takeSecrets(env: NodeJS.ProcessEnv = process.env): Partial<Record<(typeof SECRET_ENV_VARS)[number], string>> {
  const out: Partial<Record<(typeof SECRET_ENV_VARS)[number], string>> = {};
  for (const k of SECRET_ENV_VARS) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
    delete env[k];
  }
  return out;
}

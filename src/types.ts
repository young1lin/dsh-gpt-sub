/** Plugin configuration shape, validated by the schemastery schema in index.ts. */
export interface Config {
  /** Proxy URL for reaching the token endpoint, e.g. http://127.0.0.1:7890; empty means direct. */
  proxyUrl: string
  /** Path to the Codex CLI credential file. */
  authFile: string
  /** Refresh the access token when less than this many minutes remain. */
  refreshMarginMinutes: number
  /** Credential the provider route names, and this plugin keeps populated. */
  tokenRef: string
  /** How often to re-read the credential file and republish the token. */
  syncIntervalMinutes: number
  /** Extra attempts per request after a dropped connection; 0 disables retry. */
  bootstrapRetries: number
  /** Where the panel's runtime overrides (proxy, credential file) are persisted. */
  stateFile: string
}

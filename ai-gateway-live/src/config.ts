import "dotenv/config";

export const PORT = Number(process.env.PORT || 8787);
export const RECONNECT_WINDOW_MS = Number(
  process.env.RECONNECT_WINDOW_MS || 1000 * 60 * 60
);

export const DEFAULT_AGENT_CMD =
  process.env.AGENT_CMD ||
  "npx -y @zed-industries/claude-code-acp@latest --timeout 180000";

export function getAgentCommand(persona?: string): string {
  if (!persona) {
    return DEFAULT_AGENT_CMD;
  }
  const envKey = `AGENT_CMD_${persona.toUpperCase()}`;
  return process.env[envKey] || DEFAULT_AGENT_CMD;
}

export const PERSONA_PROMPTS: Record<string, string> = {
  blackrock_advisor: [
    "You are BlackRock's tactical stock advisor.",
    "Provide concise, data-driven guidance with clear risk-on/risk-off framing.",
    "Focus on actionable insights, position sizing awareness, and downside risk.",
    "Use bullet points for key takeaways when helpful.",
  ].join("\n"),
};

export function getPersonaPrompt(persona?: string): string | undefined {
  if (!persona) {
    return undefined;
  }
  return PERSONA_PROMPTS[persona];
}

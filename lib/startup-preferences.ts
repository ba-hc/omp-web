import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import type { Settings } from "@oh-my-pi/pi-coding-agent";

export interface ExplicitStartupPreferences {
  thinkingLevel?: ConfiguredThinkingLevel;
}

export interface EffectiveStartupPreferences {
  thinkingLevel: ThinkingLevel;
  supportsThinking: boolean;
}

/**
 * Persist an explicit browser thinking choice without re-running AgentSession setters.
 *
 * The session constructor already records the effective model and thinking
 * level. Calling setModel()/setThinkingLevel() again would append duplicate
 * session entries and emit duplicate extension events.
 *
 * A model picked for a new browser session is session-scoped. Persistent model
 * role changes go through the model-roles UI/API instead.
 */
export async function persistExplicitStartupPreferences(
  settings: Settings,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<void> {
  if (!explicit.thinkingLevel) return;

  if (
    explicit.thinkingLevel
    && (explicit.thinkingLevel === "auto" || effective.supportsThinking || effective.thinkingLevel !== "off")
  ) {
    settings.set("defaultThinkingLevel", (explicit.thinkingLevel === "auto" ? "auto" : effective.thinkingLevel) as never);
  }

  await settings.flush();
}

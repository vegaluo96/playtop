// 三级配置覆盖（docs/01 §2.5 / docs/02 §6.1）。
//
//   用户自定义  >  角色配置  >  全局默认
//
// 「音色 / TTS模型 / prompt / 记忆深度 / 回复长度」三级可覆盖；「视觉/背景」全局固定，
// 不可被角色或用户覆盖（背景一致性的硬约束）。运行时只改配置、不动对话逻辑。
import type { CharacterSpec, GlobalDefaults } from "./schema.ts";

/** per-user × per-character 的自定义音色（对应 Admin「用户语音」、前端 voiceByChar）。 */
export interface UserVoice {
  user_id: string;
  character_id: string;
  voice_id: string;
  label?: string;
}

const firstDefined = <T,>(...vals: (T | null | undefined)[]): T | undefined =>
  vals.find((v) => v !== null && v !== undefined) as T | undefined;

/** 运行时取音色：user_voice(user,char) ?? character.voice.voice_id ?? global.default_voice */
export function resolveVoiceId(char: CharacterSpec, g: GlobalDefaults, userVoice?: UserVoice | null): string {
  return (
    firstDefined(userVoice?.voice_id || undefined, char.voice.voice_id || undefined, g.default_voice) ??
    g.default_voice
  );
}

export function resolveTtsModel(char: CharacterSpec, g: GlobalDefaults): string {
  return firstDefined(char.runtime_overrides?.tts_model ?? undefined, g.tts_model) ?? g.tts_model;
}

export function resolveMemoryDepth(char: CharacterSpec, g: GlobalDefaults): number {
  return firstDefined(char.runtime_overrides?.memory_depth ?? undefined, g.memory_depth) ?? g.memory_depth;
}

export function resolveReplyMaxTokens(char: CharacterSpec, g: GlobalDefaults): number {
  return (
    firstDefined(char.runtime_overrides?.reply_max_tokens ?? undefined, g.reply_max_tokens) ?? g.reply_max_tokens
  );
}

/** 实时 system prompt 的角色专属追加指令（角色级，可空）。 */
export function resolveRealtimePromptExtra(char: CharacterSpec): string {
  return char.runtime_overrides?.realtime_prompt_extra ?? "";
}

export interface ResolvedRuntimeConfig {
  character_id: string;
  voice_id: string;
  tts_model: string;
  memory_depth: number;
  reply_max_tokens: number;
  realtime_prompt_extra: string;
}

/** 一次性解出某用户对某角色的运行时配置（背景/视觉永远走全局，不在此处）。 */
export function resolveRuntimeConfig(
  char: CharacterSpec,
  g: GlobalDefaults,
  userVoice?: UserVoice | null,
): ResolvedRuntimeConfig {
  return {
    character_id: char.identity.character_id,
    voice_id: resolveVoiceId(char, g, userVoice),
    tts_model: resolveTtsModel(char, g),
    memory_depth: resolveMemoryDepth(char, g),
    reply_max_tokens: resolveReplyMaxTokens(char, g),
    realtime_prompt_extra: resolveRealtimePromptExtra(char),
  };
}

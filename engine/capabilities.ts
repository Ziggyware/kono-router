// engine/capabilities.ts — model capability analysis, extracted from engine/providers.ts.

// ============================================================================
// 3. VERIFIED OCT-2026 CAPABILITY PARSER & SHANNON ENTROPY POISON GUARD
// ============================================================================

export interface ModelCapabilityProfile {
  iqPrior: number;
  supportsReasoning: boolean;
  supportsVision: boolean;
  isCodingSpecialist: boolean;
}





export function analyzeModelCapabilities(modelId: string, contextLength: number = 128000): ModelCapabilityProfile {
  const m = modelId.toLowerCase();

  // Exclude non-chat, moderation/guardrail, audio-only, image-gen, and embedding endpoints
  // Note: nvidia/nemotron-3.5-content-safety:free is a guardrail moderation classifier, not a general chat LLM
  if (
    /embed|bge-|e5-|whisper|tts|kokoro|flux|sdxl|stable-diffusion|\bsd3|dall-e|gpt-image|imagen|veo-|bria|recraft|ideogram|kandinsky|hidream|seedream|seededit|cogview|qwen-image|playground-v|kling|hunyuan-video|ltx-video|wan-?2|moderation|guard|content-safety|rerank|suno|udio|respan/i
      .test(m)
  ) {
    return { iqPrior: 0.0, supportsReasoning: false, supportsVision: false, isCodingSpecialist: false };
  }

  let baseScore = 0.56;

  // Tier 0: October 2026 Apex Frontier (AA Intelligence Index 52.5 - 57.6 / Vals #1)
  // Includes: Claude Opus 5.5 (57.6), Claude Sonnet 5.5 (56.0), Kimi K3.1 Pro (55.1, 2.8T/104B),
  // Claude Fable 5.1 (53.4), Gemini 4 Argon (52.6, #1 Vals Index), GPT-6.1 Terra, GPT-6 Astra
  if (
    /claude-opus-5(\.5)?|claude-sonnet-5(\.5)?|claude-fable-5(\.1)?|kimi-k3(\.1)?-pro|gemini-4-argon|argon|gpt-6(\.1)?-(terra|astra)|space-bunny-alpha/i
      .test(m)
  ) {
    baseScore = 0.975;
  } // Tier 1: Late-2026 Flagships & Ultra-Heavy Free MoEs
  // Includes: Grok 4.7 / 4.5 / 4.4 / 4-Heavy, Gemini 3.1 Pro (77.1% ARC-AGI-2), Gemini 3.8 Flash, Gemini 2.8,
  // Qwen3.8 Max, DeepSeek V4 Pro (1.6T/49B), DeepSeek V4.1 Flash (1017 CED), GLM 5.3,
  // ThinkingMachines Inkling (975B/41B :free), NVIDIA Nemotron 3 Ultra (550B/55B :free),
  // Poolside Laguna S 2.1 (118B/8B :free), Dots3-Note Preview (280B/16B :free)
  else if (
    /grok-4(\.[13457]|-heavy)?(?!-mini)|gemini-(3\.[158]|2\.8)-(pro|flash)|qwen3\.8-max|deepseek-v4(\.1)?-(pro|flash)|glm-5\.3|thinkingmachines\/inkling(?!-small)|nemotron-3-ultra-550b|laguna-s-2\.1|dots-3-note|claude-4-[57]|claude-opus-4|gpt-5\.6-sol|o3(?!-mini)|o4(?!-mini)/i
      .test(m)
  ) {
    baseScore = 0.935;
  } // Tier 2: High-Efficiency Agentic, Coding & Multimodal Workhorses (Oct 2026 :free core)
  // Includes: GPT-6 Luna, GPT-5.6 Luna, Kimi K3 / K2, DeepSeek V4 Flash 0731, DeepSeek V3.2, DeepSeek R1 0528,
  // Inkling Small (276B/12B :free), Nemotron 3 Super (120B/12B :free), Qwen3.8 27B (:free),
  // Gemma 4 31B IT (:free), Gemma 4 26B A4B (:free), Cohere North Mini Code (30B/3B :free),
  // Poolside Laguna XS 2.1 (:free), Recursive Flint (40B/2.5B :free), Xing4.0 29B A4B (:free),
  // MiMo-V2.6-Flash, Tencent Hy4 Preview, MiniMax M2, OpenRouter Auto-Free Router (openrouter/free)
  else if (
    /gpt-6-luna|gpt-5\.6-luna|kimi-k[23]|deepseek-v4-flash|deepseek-v3\.2|deepseek-r1|inkling-small|nemotron-3-super-120b|qwen3\.8-27b|qwen3(\.5)?-(32b|72b|235b|coder)|gemma-?4-(31b|26b)|north-mini-code|laguna-xs-2\.1|recursive\/flint|xing4\.0-29b|mimo-v2\.6|hy4-preview|minimax-m2|ling-3\.0-flash|solar-pro-4|openrouter\/free|kilo-auto\/free|claude-3-[57]-sonnet|gpt-4\.1(?!-nano|-mini)|llama-4-(maverick|behemoth)/i
      .test(m)
  ) {
    baseScore = 0.875;
  } // Tier 3: High-Throughput Agent Lightning & Perception Sub-Agents
  // Includes: Nemotron 3.5 Lightning (30B/3B :free, 1M ctx), Nemotron 3 Nano Omni (30B/3B :free),
  // Nemotron 3.5 Bolt E4B, Apodex 1.1 Mini (:free), Gemma 3 27B, Llama 3.3 70B, Llama 4 Scout
  else if (
    /nemotron-3\.5-lightning|nemotron-3-nano-omni|nemotron-3\.5-bolt|apodex-1\.1-mini|gemma-?3-27b|llama-3\.3-70b|llama-4-scout|qwen-?2\.5-(coder-32b|72b)|codestral|mistral-large|glm-4\.5|grok-4-mini|grok-3|gpt-4o-mini|claude-3-5-haiku|kilo-auto\/small/i
      .test(m)
  ) {
    baseScore = 0.77;
  } // Tier 4: Compact Extraction / Edge 2B-9B Models
  // Note: Liquid LFM2.5-2.6B (:free) is explicitly advised by Liquid AI for RAG/extraction, NOT agentic coding
  else if (
    /lfm-2\.5-2\.6b|gemma-?[34]-(9b|12b)|qwen3-(8b|4b)|llama-3\.[12]-(8b|11b)|ministral|mistral-nemo|phi-4|flash-lite/i
      .test(m)
  ) {
    baseScore = 0.52;
  } // Tier 5: Sub-2B Micro Models
  else if (/0\.5b|0\.6b|1b|1\.5b|tinyllama|smollm/i.test(m)) {
    baseScore = 0.35;
  }

  const supportsReasoning =
    /argon|claude-opus-5|claude-sonnet-5|claude-fable-5|kimi-k3|gpt-6|grok-4|gemini-3|gemini-2\.8|deepseek-v4|deepseek-v3\.2|deepseek-r1|glm-5|qwen3\.8|inkling|nemotron-3|dots-3|xing4\.0|apodex|lfm-2\.5|o1|o3|o4|thinking|reason/i
      .test(m);

  const supportsVision =
    /argon|claude-opus-5|claude-sonnet-5|kimi-k3|gpt-6|grok-4|gemini|qwen3\.8|gemma-?4-(26b|31b)|inkling|nemotron-3-nano-omni|dots-3|deepseek-v3\.2|vision|vl|pixtral|llama-4/i
      .test(m);

  // Code-tuned models only: strong generalists rank on IQ, and flagging them
  // here erased the code lane's difference from the smart lane.
  const isCodingSpecialist =
    /laguna|north-mini-code|flint|coder|codestral|devstral|codex|starcoder|codegemma|code-?llama|-code\b/i
      .test(m);

  if (isCodingSpecialist) baseScore += 0.015;
  if (contextLength >= 256000) baseScore += 0.01;
  if (contextLength >= 1000000) baseScore += 0.01;

  return {
    iqPrior: Math.min(0.995, Number(baseScore.toFixed(3))),
    supportsReasoning,
    supportsVision,
    isCodingSpecialist,
  };
}

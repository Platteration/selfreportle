/* Explicit model/product identifiers from primary documentation, 2021–2025.
 * These names are evidence only inside a disclosure or a generator/model
 * field. A mention in an article is not evidence that the article used AI. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.modelCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODELS = [
    {
      id: 'eleutherai', name: 'EleutherAI GPT-Neo / GPT-J / GPT-NeoX / Pythia', vendor: 'EleutherAI', country: 'United States / international', kinds: ['text', 'code'],
      disclosureName: '(?:eleuther[\\s_-]?ai(?:[\\s/_-]+(?:gpt[\\s_-]?(?:neo(?:x)?|j)|pythia))?|gpt[\\s_-]?(?:neo(?:x)?|j)(?:[\\s_-]\\d+(?:\\.\\d+)?[bm])?|pythia[\\s_-]\\d+(?:\\.\\d+)?[bm])',
      source: 'https://github.com/EleutherAI/gpt-neo/blob/master/README.md', year: 2021,
      sources: ['https://github.com/EleutherAI/gpt-neox/blob/main/README.md', 'https://github.com/EleutherAI/pythia/blob/main/README.md', 'https://github.com/kingoflolz/mesh-transformer-jax/blob/master/README.md'],
      limitation: 'These releases include base language models and research checkpoints. A release name does not establish instruction tuning or the safeguards of the operator using it.',
    },
    {
      id: 'bloom', name: 'BigScience BLOOM', vendor: 'BigScience research workshop', country: 'International', kinds: ['text', 'code'],
      disclosureName: '(?:bigscience[\\s/_-]+bloom|bloom[\\s_-]176b)',
      source: 'https://github.com/bigscience-workshop/model_card/blob/main/README.md', year: 2022,
      limitation: 'BLOOM is a multilingual base language model. Its model card describes language and use limitations; the name alone does not establish a chat-tuned model or equal quality across languages.',
    },
    {
      id: 'mpt', name: 'MosaicML MPT', vendor: 'MosaicML / Databricks', country: 'United States', kinds: ['text', 'code'],
      disclosureName: '(?:mosaicml(?:[\\s/_-]+mpt)?|mpt[\\s_-](?:7b|30b))',
      source: 'https://github.com/mosaicml/llm-foundry/blob/main/README.md', year: 2023,
      limitation: 'MPT releases include base, instruction, chat and StoryWriter variants with different context lengths and tuning. The family name does not distinguish those capabilities.',
    },
    {
      id: 'falcon', name: 'TII Falcon-H1', vendor: 'Technology Innovation Institute', country: 'United Arab Emirates', kinds: ['text', 'code'],
      disclosureName: '(?:tii(?:uae)?[\\s/_-]+falcon[\\s_-]h1|falcon[\\s_-]h1)',
      source: 'https://github.com/tiiuae/Falcon-H1/blob/main/README.md', year: 2025,
      limitation: 'Falcon-H1 is a hybrid state-space and attention model family with multiple sizes. This identifier names that release family; it does not attribute ordinary mentions of falcons or older Falcon models.',
    },
    {
      id: 'gemma', name: 'Google Gemma / CodeGemma', vendor: 'Google', country: 'United States', kinds: ['text', 'code'],
      disclosureName: '(?:google[\\s/-]+gemma|gemma[\\s_-]?[123](?:\\.\\d+)?|codegemma)',
      source: 'https://github.com/google/gemma_pytorch/blob/main/README.md', year: 2024,
      limitation: 'Gemma is an open-weight family distinct from the hosted Gemini product; local operators can fine-tune it, so a family identifier does not identify the service or its safeguards.',
    },
    {
      id: 'phi', name: 'Microsoft Phi', vendor: 'Microsoft', country: 'United States', kinds: ['text', 'code'],
      disclosureName: '(?:microsoft[\\s/-]+phi|phi[\\s_-]?[234](?:\\.\\d+)?)',
      source: 'https://github.com/microsoft/PhiCookBook/blob/main/README.md', year: 2024,
      limitation: 'Phi includes small text, vision and reasoning variants with different capabilities. A version name alone does not establish which variant or local configuration produced an answer.',
    },
    {
      id: 'cohere', name: 'Cohere Command / Aya', vendor: 'Cohere', country: 'Canada', kinds: ['text', 'code'],
      disclosureName: '(?:cohere(?:[\\s/-]+(?:command|aya))?|command[\\s_-][ra](?:[\\s_-]plus)?|c4ai[\\s/-]+aya|aya[\\s_-](?:23|expanse|vision))',
      source: 'https://github.com/cohere-ai/cohere-python/blob/main/README.md', year: 2024,
      sources: ['https://github.com/cohere-ai/cohere-developer-experience/blob/main/fern/pages/models/aya.mdx'],
      limitation: 'Command supports retrieval and tool use. Citations describe supplied sources and still need to be checked against the original documents.',
    },
    {
      id: 'ai21', name: 'AI21 Jamba', vendor: 'AI21 Labs', country: 'Israel', kinds: ['text', 'code'],
      disclosureName: '(?:ai21(?:[\\s_-]+labs)?|jamba[\\s_-](?:mini|large|1\\.5))',
      source: 'https://github.com/AI21Labs/ai21-python/blob/main/README.md', year: 2024,
      limitation: 'Jamba model identifiers name a chat model, while tool calls and retrieved documents are supplied by the surrounding application; their presence does not establish independent fact checking.',
    },
    {
      id: 'granite', name: 'IBM Granite', vendor: 'IBM', country: 'United States', kinds: ['text', 'code'],
      disclosureName: '(?:ibm[\\s/-]+granite|granite[\\s_-][234](?:\\.\\d+)?)',
      source: 'https://github.com/ibm-granite/granite-3.1-language-models/blob/main/README.md', year: 2024,
      limitation: 'Granite has base and instruction-tuned variants. Open weights allow operators to change tuning and prompts, so the family name cannot establish the deployment’s behaviour.',
    },
    {
      id: 'olmo', name: 'Allen Institute OLMo', vendor: 'Allen Institute for AI', country: 'United States', kinds: ['text', 'code'],
      disclosureName: '(?:olmo(?:[\\s_-]?[23])?|allenai[\\s/-]+olmo)',
      source: 'https://github.com/allenai/OLMo/blob/main/README.md', year: 2024,
      limitation: 'OLMo releases include training checkpoints and instruction-tuned models. Identifying the family does not establish that an output came from a chat-tuned checkpoint.',
    },
    {
      id: 'kimi', name: 'Moonshot AI Kimi', vendor: 'Moonshot AI', country: 'China', kinds: ['text', 'code'],
      disclosureName: '(?:moonshot[\\s_-]?ai|kimi[\\s_-]?(?:k2|k1\\.5)|kimi\\.ai)',
      source: 'https://github.com/MoonshotAI/Kimi-K2/blob/main/README.md', year: 2025,
      limitation: 'Kimi K2 includes base and instruction-tuned models and can call tools. Tool-call format identifies a protocol; compatible tools or derivatives can reuse it.',
    },
    {
      id: 'minimax', name: 'MiniMax M1', vendor: 'MiniMax', country: 'China', kinds: ['text', 'code'],
      disclosureName: '(?:minimax[\\s_-]?(?:ai|m1)|minimax\\.io)',
      source: 'https://github.com/MiniMax-AI/MiniMax-M1/blob/main/README.md', year: 2025,
      limitation: 'MiniMax M1 is an open-weight reasoning model. Reasoning or assistant delimiters can survive an export, but do not authenticate the model or establish factual accuracy.',
    },
    {
      id: 'glm', name: 'Z.ai / Zhipu GLM', vendor: 'Zhipu AI / Z.ai', country: 'China', kinds: ['text', 'code'],
      disclosureName: '(?:zhipu[\\s_-]?ai|z\\.ai|chatglm[\\s_-]?[234]?|glm[\\s_-]?(?:[34](?:\\.\\d+)?|z1))',
      source: 'https://github.com/THUDM/GLM-4/blob/main/README.md', year: 2024,
      limitation: 'GLM includes chat, reasoning and vision variants. Plain assistant role tags are shared with other model families and cannot identify GLM by themselves.',
    },
    {
      id: 'internlm', name: 'InternLM', vendor: 'Shanghai AI Laboratory', country: 'China', kinds: ['text', 'code'],
      disclosureName: 'internlm(?:[\\s_-]?[23](?:\\.\\d+)?)?',
      source: 'https://github.com/InternLM/InternLM/blob/main/README.md', year: 2023,
      limitation: 'InternLM releases base and chat models with tool support. An application’s tools and prompt configuration affect behaviour beyond what the family name describes.',
    },
    {
      id: 'yi', name: '01.AI Yi', vendor: '01.AI', country: 'China', kinds: ['text', 'code'],
      disclosureName: '(?:01[.\\s_-]?ai(?:[\\s/-]+yi)?|yi[\\s_-](?:1\\.5|6b|9b|34b|vl))',
      source: 'https://github.com/01-ai/Yi/blob/main/README.md', year: 2023,
      limitation: 'Yi includes English/Chinese base and chat variants. A model identifier names a family or checkpoint, rather than the author or operator of a specific passage.',
    },
    {
      id: 'baichuan', name: 'Baichuan', vendor: 'Baichuan', country: 'China', kinds: ['text', 'code'],
      disclosureName: 'baichuan(?:[\\s_-]?[12])?',
      source: 'https://github.com/baichuan-inc/Baichuan2/blob/main/README_EN.md', year: 2023,
      limitation: 'Baichuan2 has base, chat and quantized checkpoints. The family identifier does not distinguish an untouched release from a third-party fine-tune.',
    },
    {
      id: 'hunyuan', name: 'Tencent Hunyuan Image / Video', vendor: 'Tencent', country: 'China', kinds: ['image', 'video'],
      disclosureName: '(?:tencent[\\s/-]+hunyuan|hunyuan[\\s_-]?(?:image|video)(?:[\\s_-]?[12](?:\\.\\d+)?)?)',
      source: 'https://github.com/Tencent-Hunyuan/HunyuanVideo/blob/main/README.md', year: 2024,
      sources: ['https://github.com/Tencent-Hunyuan/HunyuanImage-2.1/blob/main/README.md'],
      limitation: 'Hunyuan image and video are separate generative model lines. A model identifier is useful provenance evidence; visual realism or an ordinary Tencent credit is not.',
    },
    {
      id: 'wan', name: 'Alibaba Wan video', vendor: 'Alibaba', country: 'China', kinds: ['image', 'video'],
      disclosureName: '(?:wan[\\s_-]?2\\.[12]|wan[\\s_-]ai|alibaba[\\s/-]+wan)',
      source: 'https://github.com/Wan-Video/Wan2.1/blob/main/README.md', year: 2025,
      limitation: 'Wan supports text-to-video, image-to-video and editing. Naming the model does not tell whether a particular export is wholly generated or an edit of a captured asset.',
    },
    {
      id: 'ltx', name: 'Lightricks LTX-Video', vendor: 'Lightricks', country: 'Israel', kinds: ['video', 'image'],
      disclosureName: '(?:ltx[\\s_-]video|lightricks[\\s/-]+ltx|ltx[\\s_-]2)',
      source: 'https://github.com/Lightricks/LTX-Video/blob/main/README.md', year: 2024,
      limitation: 'LTX generates video from text or images. A model name in export metadata identifies the stated workflow, while appearance alone cannot establish generation.',
    },
    {
      id: 'suno', name: 'Suno / Bark', vendor: 'Suno', country: 'United States', kinds: ['audio'],
      disclosureName: '(?:suno(?:[\\s_-]ai)?(?:[\\s/-]+bark)?|bark[\\s_-](?:v0|model))',
      source: 'https://github.com/suno-ai/bark/blob/main/README.md', year: 2023,
      limitation: 'Bark is generative text-to-audio rather than conventional text-to-speech and can deviate from the supplied words. An explicit credit names a tool; this reader does not analyze its sound.',
    },
    {
      id: 'audiocraft', name: 'Meta AudioCraft / MusicGen / AudioGen', vendor: 'Meta', country: 'United States', kinds: ['audio'],
      disclosureName: '(?:audiocraft|musicgen|audiogen)',
      source: 'https://github.com/facebookresearch/audiocraft/blob/main/README.md', year: 2023,
      limitation: 'MusicGen generates music and AudioGen generates sound. A model name in a credit or metadata is a declaration; this reader does not perform audio classification.',
    },
    {
      id: 'elevenlabs', name: 'ElevenLabs voice generation', vendor: 'ElevenLabs', country: 'United States', kinds: ['audio'],
      disclosureName: '(?:elevenlabs|eleven[\\s_-](?:v3|multilingual[\\s_-]v2))',
      source: 'https://github.com/elevenlabs/elevenlabs-python/blob/main/README.md', year: 2023,
      limitation: 'ElevenLabs includes speech and voice generation models. A declared model identifier does not establish the speaker’s identity or authenticate what they said.',
    },
    {
      id: 'openai', name: 'OpenAI models', kinds: ['text', 'code'],
      disclosureName: 'gpt[\\s_-]oss(?:[\\s_-](?:20b|120b))?',
      source: 'https://github.com/openai/gpt-oss/blob/main/README.md', year: 2025,
    },
    {
      id: 'meta', name: 'Meta Llama', kinds: ['text', 'code'],
      disclosureName: 'llama[\\s_-]?[234](?:\\.\\d+)?',
      source: 'https://github.com/meta-llama/llama-models/blob/main/README.md', year: 2024,
    },
    {
      id: 'alibaba', name: 'Alibaba Qwen', kinds: ['text', 'code', 'image'],
      disclosureName: '(?:qwen(?:[\\s_-]?[123](?:\\.\\d+)?|[\\s_-]image)?|qwq[\\s_-]32b)',
      source: 'https://github.com/QwenLM/Qwen3/blob/main/README.md', year: 2025,
      sources: ['https://github.com/QwenLM/Qwen-Image/blob/main/README.md'],
    },
    {
      id: 'mistral', name: 'Mistral / Mixtral / Codestral / Pixtral', kinds: ['text', 'code'],
      disclosureName: '(?:mistral[\\s_-]ai|mixtral(?:[\\s_-]8x[72]2?b)?|codestral|pixtral)',
      source: 'https://github.com/mistralai/mistral-inference/blob/main/README.md', year: 2024,
    },
    {
      id: 'bfl', name: 'Black Forest Labs FLUX', kinds: ['image', 'video'],
      disclosureName: '(?:black[\\s_-]forest[\\s_-]labs|flux[.\\s_-]?(?:1|dev|schnell|pro|kontext|ultra))',
      source: 'https://github.com/black-forest-labs/flux/blob/main/README.md', year: 2024,
    },
    // Interfaces can run many model families. Keep them after model names.
    {
      id: 'comfyui', name: 'ComfyUI (generation interface)', vendor: 'Comfy Org / community', country: 'Worldwide', kinds: ['image', 'video'],
      disclosureName: 'comfyui',
      source: 'https://github.com/Comfy-Org/ComfyUI/blob/master/README.md', year: 2023,
      limitation: 'ComfyUI supports Stable Diffusion, FLUX, Qwen Image and other image/video models. Its workflow identifies the interface; the underlying model remains unknown unless the export names it.',
    },
  ].map((m) => ({
    ...m,
    match: new RegExp('\\b(?:' + m.disclosureName + ')(?![a-z0-9])', 'i'),
    marking: 'Recognized from explicit disclosures or generator/model identifiers. Export metadata can be edited or removed; this reader does not verify hidden watermarks for this family.',
  }));

  const TOOL_NAMES = '(?:' + MODELS.map((m) => m.disclosureName).join('|') + ')';

  // Require every marker in an entry. Tokens document a serialization format,
  // which derivatives and hand-written examples can reuse; they are not a
  // cryptographic authorship claim. No unbounded cross-text regex is needed.
  const TEXT_ARTIFACTS = [
    {
      id: 'llama-header', label: 'Llama-family conversation format', toolId: 'meta',
      markers: [/<\|start_header_id\|>\s*assistant\s*<\|end_header_id\|>/, /<\|eot_id\|>/],
      source: 'https://github.com/meta-llama/llama3/blob/main/llama/tokenizer.py',
    },
    {
      id: 'gemma-turn', label: 'Gemma-family conversation format', toolId: 'gemma',
      markers: [/<start_of_turn>model\b/, /<end_of_turn>/],
      source: 'https://github.com/google/gemma_pytorch/blob/main/scripts/run_multimodal.py',
    },
    {
      id: 'harmony-header', label: 'OpenAI Harmony conversation format', toolId: 'openai',
      markers: [/<\|start\|>assistant\b[^<\n]{0,120}(?:<\|channel\|>[^<\n]{1,120})?(?:<\|constrain\|>[^<\n]{1,80})?<\|message\|>/, /<\|(?:end|return|call)\|>/],
      source: 'https://github.com/openai/harmony/blob/main/src/encoding.rs',
    },
    {
      id: 'minimax-turn', label: 'MiniMax-family conversation format', toolId: 'minimax',
      markers: [/<beginning_of_sentence>ai name=assistant\b/, /<end_of_sentence>/],
      source: 'https://github.com/MiniMax-AI/MiniMax-M1/blob/main/tokenizer_config.json',
    },
    {
      id: 'kimi-tool-section', label: 'Kimi-family tool-call format', toolId: 'kimi',
      markers: [/<\|tool_calls_section_begin\|>/, /<\|tool_calls_section_end\|>/, /<\|tool_call_begin\|>/, /<\|tool_call_end\|>/],
      source: 'https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md',
    },
    {
      id: 'shared-chatml', label: 'Shared ChatML conversation format', toolId: null,
      markers: [/<\|im_start\|>user\b/, /<\|im_start\|>assistant\b/, /<\|im_end\|>/],
      source: 'https://github.com/QwenLM/Qwen/blob/main/finetune.py',
    },
    {
      id: 'shared-role-format', label: 'Shared assistant conversation format', toolId: null,
      markers: [/<\|user\|>/, /<\|assistant\|>/],
      source: 'https://github.com/THUDM/ChatGLM3/blob/main/PROMPT_en.md',
    },
    {
      id: 'shared-reasoning', label: 'Shared reasoning delimiters', toolId: null,
      markers: [/<think>/, /<\/think>/],
      source: 'https://github.com/QwenLM/Qwen3/blob/main/README.md',
    },
  ];

  function matchModel(text, kinds) {
    if (!text) return null;
    return MODELS.find((m) => (!kinds || m.kinds.some((k) => kinds.includes(k))) && m.match.test(text)) || null;
  }

  return { MODELS, TOOL_NAMES, TEXT_ARTIFACTS, matchModel };
});

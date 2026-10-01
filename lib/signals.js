/*
 * lib/signals.js — pattern catalogue shared by every analyzer.
 *
 * Loaded as a plain script in the extension (content script, popup, service
 * worker via importScripts) and as a CommonJS module under Node for tests.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.signals = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const LEX = (typeof module === 'object' && typeof require === 'function') ? require('./lexicons.js') : (root.SRL && root.SRL.lexicons);

  const IPTC_DST_PREFIX = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

  /* IPTC "Digital Source Type" controlled vocabulary. This is the vocabulary
   * both C2PA actions and XMP (Iptc4xmpExt:DigitalSourceType) use to say how
   * an asset came to be. It is the closest thing to a machine-readable
   * "this was made by generative AI" flag that exists today. */
  const DIGITAL_SOURCE_TYPES = {
    trainedAlgorithmicMedia: { verdict: 'ai-generated', strength: 0.97, label: 'Created by generative AI (trainedAlgorithmicMedia)' },
    compositeWithTrainedAlgorithmicMedia: { verdict: 'ai-edited', strength: 0.95, label: 'Composite containing generative-AI elements' },
    compositeSynthetic: { verdict: 'ai-edited', strength: 0.85, label: 'Synthetic composite' },
    algorithmicMedia: { verdict: 'algorithmic', strength: 0.8, label: 'Created by a non-trained algorithm (procedural / rendered)' },
    virtualRecording: { verdict: 'algorithmic', strength: 0.7, label: 'Recording of a virtual scene' },
    dataDrivenMedia: { verdict: 'algorithmic', strength: 0.5, label: 'Data-driven media (rendered from data)' },
    algorithmicallyEnhanced: { verdict: 'captured', strength: 0.5, label: 'Capture enhanced by an algorithm (e.g. phone processing)' },
    digitalCapture: { verdict: 'captured', strength: 0.9, label: 'Original digital capture (camera)' },
    compositeCapture: { verdict: 'captured', strength: 0.7, label: 'Composite of captured images' },
    negativeFilm: { verdict: 'captured', strength: 0.9, label: 'Scanned from negative film' },
    positiveFilm: { verdict: 'captured', strength: 0.9, label: 'Scanned from positive film' },
    print: { verdict: 'captured', strength: 0.8, label: 'Scanned from a print' },
    minorHumanEdits: { verdict: 'captured', strength: 0.8, label: 'Capture with minor human edits' },
    humanEdits: { verdict: 'captured', strength: 0.6, label: 'Capture with human edits' },
    screenCapture: { verdict: 'captured', strength: 0.5, label: 'Screen capture' },
    digitalCreation: { verdict: 'human-created', strength: 0.85, label: 'Human-made digital creation (drawn / designed)' },
    composite: { verdict: 'unknown', strength: 0.2, label: 'Composite (unspecified)' },
  };

  /*
   * The verdicts a file can only ever *claim* for itself.
   *
   * A statement that a camera or a human made this is the one worth forging,
   * and an IPTC digitalSourceType is a plain string in an XMP packet: writing
   * it costs one line of text. So these are read as provenance only when
   * something cryptographic establishes them, and are reported as claims
   * otherwise. Claims of AI generation are not in this set — a declaration
   * against interest is not worth forging, so it is read either way.
   */
  const EXCULPATORY_VERDICTS = new Set(['captured', 'human-created', 'algorithmic']);

  function digitalSourceType(value) {
    if (!value) return null;
    const v = String(value).trim();
    const key = v.startsWith(IPTC_DST_PREFIX) ? v.slice(IPTC_DST_PREFIX.length) : v.split('/').pop();
    const entry = DIGITAL_SOURCE_TYPES[key];
    return entry ? { key, ...entry } : { key, verdict: 'unknown', strength: 0.2, label: 'Digital source type: ' + key };
  }

  /* Names of generative image/video tools. Used on metadata fields (XMP
   * CreatorTool, EXIF Software, C2PA claim generators, PNG text chunks), on
   * URLs and on alt/caption text. */
  const AI_IMAGE_TOOLS = [
    ['DALL·E', /dall[\s·•\-_]?e/i],
    ['ChatGPT / OpenAI', /chatgpt|openai|gpt-image|gpt-?4o/i],
    ['Sora', /\bsora\b/i],
    ['Midjourney', /midjourney|\bniji\b/i],
    ['Stable Diffusion', /stable[\s_-]?diffusion|\bsdxl\b|\bsd[\s_-]?(?:1\.5|2\.1|3(?:\.5)?)\b|stability\s?ai/i],
    ['FLUX', /\bflux[.\-_ ]?(?:1|dev|schnell|pro|kontext|ultra)\b/i],
    ['Adobe Firefly', /firefly/i],
    ['Adobe generative AI', /generative\s?(?:fill|expand|remove)|photoshop.*generative/i],
    ['Google Imagen', /\bimagen\b/i],
    ['Google Gemini', /\bgemini\b|nano[\s-]?banana/i],
    ['Google Veo', /\bveo[\s-]?[23]?\b/i],
    ['Microsoft Designer / Bing Image Creator', /bing image creator|microsoft designer|image creator/i],
    ['Meta AI', /\bmeta ai\b|imagine\.meta|\bemu\b/i],
    ['Grok / xAI', /\bgrok\b|\bxai\b/i],
    ['Ideogram', /ideogram/i],
    ['Leonardo AI', /leonardo[\s._-]?ai/i],
    ['ComfyUI', /comfyui/i],
    ['AUTOMATIC1111 / SD WebUI', /automatic1111|a1111|sd-webui|stable-diffusion-webui/i],
    ['Fooocus', /fooocus/i],
    ['NovelAI', /novelai/i],
    ['InvokeAI', /invokeai/i],
    ['Runway', /runway(?:ml)?\b/i],
    ['Pika', /\bpika(?:labs)?\b/i],
    ['Kling', /\bkling(?:ai)?\b/i],
    ['Luma Dream Machine', /luma(?:labs)?|dream machine/i],
    ['Recraft', /recraft/i],
    ['Krea', /\bkrea\b/i],
    ['Playground AI', /playground\s?ai|playgroundai/i],
    ['Lexica', /lexica/i],
    ['NightCafe', /nightcafe/i],
    ['Craiyon', /craiyon/i],
    ['Artbreeder', /artbreeder/i],
    ['Dream by WOMBO', /\bwombo\b/i],
    ['Pollinations', /pollinations/i],
    ['Canva Magic Media', /magic\s?(?:media|studio|design|edit)/i],
    ['DreamStudio', /dreamstudio/i],
    ['Civitai', /civitai/i],
    ['Tensor.Art', /tensor\.art/i],
    ['Replicate', /replicate\.(?:com|delivery)/i],
    ['fal.ai', /\bfal\.ai\b|fal\.media/i],
    ['Hugging Face', /huggingface|hf\.space/i],
    ['SeaArt', /seaart/i],
    ['Freepik AI', /freepik.*(?:ai|pikaso)|pikaso/i],
    ['Getimg', /getimg/i],
    ['Kaiber', /kaiber/i],
    ['HeyGen', /heygen/i],
    ['Synthesia', /synthesia/i],
    ['D-ID', /\bd-id\b/i],
  ];

  /* Names of generative text tools. */
  const AI_TEXT_TOOLS = [
    ['ChatGPT', /chat\s?gpt/i],
    ['GPT', /\bgpt-?(?:3(?:\.5)?|4(?:o|\.\d)?|5(?:\.\d)?|o\d)\b/i],
    ['OpenAI', /\bopen\s?ai\b/i],
    ['Claude', /\bclaude\b/i],
    ['Anthropic', /anthropic/i],
    ['Gemini', /\bgemini\b/i],
    ['Bard', /\bbard\b/i],
    ['Copilot', /copilot/i],
    ['Llama', /\bllama[\s-]?\d/i],
    ['Mistral', /\bmistral\b/i],
    ['DeepSeek', /deepseek/i],
    ['Qwen', /\bqwen\b/i],
    ['Grok', /\bgrok\b/i],
    ['Perplexity', /perplexity/i],
    ['Jasper', /\bjasper\s?(?:ai)?\b/i],
    ['Copy.ai', /copy\.ai/i],
    ['Writesonic', /writesonic/i],
    ['Rytr', /\brytr\b/i],
    ['Notion AI', /notion\s?ai/i],
    ['Sudowrite', /sudowrite/i],
  ];

  /* Generic regex used on C2PA claim generators / software agents to decide
   * "this producer is a generative AI system". */
  /* Word-bounded throughout, and the fragments that are also ordinary given
   * names ("Leonardo", "Playground", "Randall") require their product suffix.
   * Without that, a JSON-LD author called Randall Cooper reads as an AI. */
  const AI_GENERATOR_RE = /\bopenai\b|\bchatgpt\b|\bdall[·\-\s]?e\b|\bsora\b|\bfirefly\b|generative\s?(?:fill|expand|ai)|\bmidjourney\b|\bstability\s?ai\b|stable[\s_-]?diffusion|\bimagen\b|\bgemini\b|google\s?(?:ai|deepmind|labs)|microsoft\s?designer|bing\s?image|\bmeta\s?ai\b|imagine\.meta|\bideogram\b|\bleonardo[.\s]?ai\b|\brecraft\b|\brunway(?:ml)?\b|\bpika\b|\bkling\b|\bluma\b|\bveo\b|\bgrok\b|\bxai\b|black\s?forest|\bflux\b|\bkrea\b|canva.*(?:magic|ai)|\bgetimg\b|playground\s?ai\b|\bcomfyui\b|\bautomatic1111\b|\bnovelai\b|\binvokeai\b|\bfooocus\b|\bsynthesia\b|\bheygen\b|\bd-id\b|adobe\s?(?:express|photoshop).*generat/i;

  /* Producers whose C2PA manifests indicate a capture device / capture app. */
  const CAPTURE_GENERATOR_RE = /\bleica\b|\bsony\b|\bnikon\b|\bcanon\b|fujifilm|\bsamsung\b|\bpixel\b|google\s?camera|truepic|\bqualcomm\b|\bcontentsign\b|\bproofmode\b|\bcapture\s?app\b|\bclick\b/i;

  /* Camera makers for EXIF Make (weak positive that the image started life as a photo). */
  const CAMERA_MAKE_RE = /^(?:canon|nikon|sony|fujifilm|fuji|olympus|om digital|panasonic|leica|pentax|ricoh|hasselblad|phase one|sigma|samsung|apple|google|huawei|xiaomi|oneplus|oppo|vivo|motorola|lg|nokia|hmd|dji|gopro|insta360|kodak|casio|blackmagic|red|arri)\b/i;

  /* Software strings that identify a generator when found in EXIF Software /
   * XMP CreatorTool / PNG Software. */
  const GENERATOR_SOFTWARE_RE = /midjourney|dall|firefly|stable\s?diffusion|automatic1111|a1111|sd-webui|comfyui|novelai|invokeai|fooocus|imagen|gemini|openai|chatgpt|leonardo|ideogram|recraft|bing image|microsoft designer|\bflux\b|draw\s?things|diffusionbee|\bkrea\b|civitai|tensor\.art|seaart|pollinations|dreamstudio|niji/i;

  /* Site builders / hosting platforms. `kind` drives the weight:
   *   ai-builder   — the product generates the site from a prompt (strong)
   *   ai-host      — hosting used mostly for AI-generated apps (medium)
   *   builder-ai   — conventional builder with prominent AI generation (weak)
   *   builder      — conventional builder; AI is optional (info only) */
  const SITE_FINGERPRINTS = [
    { name: 'Lovable', kind: 'ai-builder', attrs: [/^data-lov-/i], scripts: [/gptengineer\.js|cdn\.gpteng\.co|lovable\.(?:dev|app)/i], comments: [/lovable/i], hosts: [/\.lovable\.app$|\.lovableproject\.com$/i] },
    { name: 'v0 by Vercel', kind: 'ai-builder', attrs: [/^data-v0-/i], scripts: [/\bv0\.(?:dev|app)\b/i], comments: [/\bv0\b/i], meta: [/^v0\b/i], hosts: [/\.v0\.(?:dev|app|build)$/i] },
    { name: 'Bolt.new', kind: 'ai-builder', scripts: [/bolt\.new|bolt\.host/i], comments: [/bolt\.new|made with bolt/i], hosts: [/\.bolt\.host$/i] },
    { name: 'Base44', kind: 'ai-builder', scripts: [/base44\.(?:app|com)/i], hosts: [/\.base44\.app$/i] },
    { name: 'Manus', kind: 'ai-builder', hosts: [/\.manus\.space$/i] },
    { name: 'Durable', kind: 'ai-builder', meta: [/durable/i], scripts: [/durable\.co/i], hosts: [/\.durable\.co$/i] },
    { name: '10Web AI Builder', kind: 'ai-builder', meta: [/10web/i], scripts: [/10web/i], hosts: [/\.10web\.(?:io|site|me)$/i] },
    { name: 'Claude Artifacts', kind: 'ai-builder', hosts: [/^claude\.site$|\.claude\.site$/i] },
    { name: 'Replit', kind: 'ai-host', hosts: [/\.replit\.app$|\.repl\.co$|\.replit\.dev$/i], scripts: [/replit\.com\/public\/js\/replit(?:-dev-)?banner/i] },
    { name: 'Hostinger Website Builder', kind: 'builder-ai', meta: [/hostinger|zyro/i] },
    { name: 'GoDaddy Website Builder', kind: 'builder-ai', meta: [/starfield|godaddy/i] },
    { name: 'Wix', kind: 'builder-ai', meta: [/wix\.com/i] },
    { name: 'Framer', kind: 'builder', meta: [/^framer/i] },
    { name: 'Squarespace', kind: 'builder', meta: [/squarespace/i] },
    { name: 'Webflow', kind: 'builder', meta: [/webflow/i] },
    { name: 'WordPress', kind: 'builder', meta: [/^wordpress/i] },
    { name: 'Shopify', kind: 'builder', meta: [/shopify/i] },
  ];

  /* Comments or code that literally say the code was produced by an AI tool. */
  const CODE_AI_COMMENT_RE = /(?:generated|written|created|built|scaffolded|made|produced|authored)\s+(?:automatically\s+)?(?:by|with|using|via)\s+(?:the\s+)?(?:github\s+copilot|copilot|cursor|windsurf|chat\s?gpt|openai|gpt-?[3-5o][\w.]*|claude(?:\s+code)?|anthropic|gemini|codex|devin|replit\s+agent|bolt(?:\.new)?|lovable|\bv0\b|base44|manus|tabnine|codeium|amazon\s+q|codewhisperer|an?\s+(?:ai|llm|large\s+language\s+model|language\s+model)|artificial\s+intelligence)/i;

  const CODE_AI_MARKER_RE = /\bai[-_]?generated\b|\bgenerated[-_]?by[-_]?ai\b|\bllm[-_]?generated\b/i;

  /* Machine-readable disclosure hooks in HTML. None of these is a formal
   * standard yet; they are conventions seen in the wild. */
  const META_DISCLOSURE_NAME_RE = /^(?:og:|twitter:|article:|dc\.|dcterms\.)?(?:ai[-_.:]?(?:generated|content|disclosure|assisted|usage|use|created|involvement|label)|generated[-_]?by[-_]?ai|content[-_]?generation|synthetic[-_]?media|genai[-_]?disclosure|machine[-_]?generated|generator[-_]?ai)$/i;
  const META_DISCLOSURE_TRUE_RE = /^(?:true|yes|1|ai|full(?:y)?|partial(?:ly)?|assisted|generated|synthetic|llm|ai[-_ ]?(?:generated|assisted|created)|human[-_ ]?reviewed)/i;
  const META_DISCLOSURE_FALSE_RE = /^(?:false|no|0|none|human(?:[-_ ]?(?:only|written|made|created))?)$/i;

  /* Visible disclosure statements. `level`:
   *   generated — declares AI generation
   *   assisted  — declares AI assistance / editing
   *   weak      — automation that may or may not be AI
   *   human     — declares human authorship / no AI */
  const AI_TOOL_WORDS = '(?:AI|A\\.I\\.|artificial intelligence|generative AI|gen ?AI|machine learning|(?:an? )?(?:large )?language model|(?:an )?LLM|chat ?GPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Bard|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly|Sora|Imagen|Grok|DeepSeek|Lovable|v0|Bolt(?:\\.new)?|Cursor|Replit Agent|Base44|Manus)';
  const DISCLOSURE_PATTERNS = [
    { level: 'generated', re: new RegExp('\\b(?:AI|A\\.I\\.)[-\\s]?generated\\b', 'i') },
    { level: 'generated', re: new RegExp('\\b(?:generated|created|produced|written|drafted|composed|authored|designed|illustrated|rendered|built|developed|coded|translated|summari[sz]ed|narrated|voiced)\\s+(?:entirely\\s+|fully\\s+|automatically\\s+|in\\s+whole\\s+)?(?:by|with|using|through|via)\\s+(?:an?\\s+|the\\s+)?' + AI_TOOL_WORDS + '\\b', 'i') },
    { level: 'generated', re: new RegExp('\\b(?:made|built|powered|created)\\s+(?:with|by|using)\\s+' + AI_TOOL_WORDS + '\\b', 'i') },
    { level: 'generated', re: /\bsynthetic (?:media|image|imagery|content|audio|video|voice|photo)\b|\bthis is (?:a )?deepfake\b|\bdigitally (?:generated|synthesi[sz]ed)\b/i },
    { level: 'assisted', re: new RegExp('\\b(?:AI|A\\.I\\.)[-\\s](?:assisted|aided|supported|enhanced|edited|augmented|reviewed|powered)\\b|\\b(?:with|using)\\s+(?:the\\s+)?(?:help|assistance|aid|support)\\s+of\\s+(?:an?\\s+)?' + AI_TOOL_WORDS + '\\b|\\bassisted\\s+by\\s+(?:an?\\s+)?' + AI_TOOL_WORDS + '\\b|\\b(?:edited|enhanced|retouched|upscaled|improved|polished|refined|proofread)\\s+(?:in\\s+part\\s+)?(?:by|with|using)\\s+(?:an?\\s+)?' + AI_TOOL_WORDS + '\\b', 'i') },
    { level: 'assisted', re: /\b(?:AI|A\.I\.) (?:was|were|has been|is|tools? (?:were|was)) used (?:to|in|for)\b|\bwe use[sd]? (?:AI|artificial intelligence|generative AI)\b/i },
    { level: 'weak', re: /\bautomatically (?:generated|translated|summari[sz]ed|created)\b|\bmachine[-\s]translat(?:ed|ion)\b|\bauto[-\s]?generated\b/i },
    { level: 'human', re: /\b(?:100\s?%|entirely|fully|completely|proudly)?\s?human[-\s](?:written|made|created|authored|generated|crafted|produced)\b|\bwritten by (?:a |real )?humans?\b|\bno (?:AI|artificial intelligence|generative AI) (?:was|were|has been|is) (?:used|involved)\b|\bwithout (?:the use of |any )?(?:AI|artificial intelligence)\b|\bnot (?:AI[-\s]generated|generated by AI|written by AI)\b|\bmade by humans?\b/i },
  ];

  /* Subject of a disclosure, inferred from the words around it. */
  const SCOPE_HINTS = [
    ['image', /\b(?:image|images|photo|photos|picture|pictures|illustration|illustrations|artwork|visual|visuals|graphic|graphics|thumbnail|cover|avatar|portrait|render|renders)\b/i],
    ['site', /\b(?:site|website|web ?page|web ?app|app|application|landing page|homepage|storefront|code|source)\b/i],
    ['text', /\b(?:article|articles|post|posts|text|texts|story|stories|content|summary|summaries|translation|translations|blog|copy|description|descriptions|review|reviews|caption|captions|transcript|paragraph|essay|report|newsletter|listing|listings)\b/i],
    ['video', /\b(?:video|videos|clip|clips|voice|voice-?over|audio|narration|podcast)\b/i],
  ];

  /* Chat-transcript leakage: sentences an assistant says to a user. */
  const SELF_REFERENCE_STRONG_RE = /\bas an ai(?: language)? model\b|\bi(?:'m| am) an ai\b|\bmy (?:knowledge|training) (?:cutoff|cut-off|data)\b|\bi (?:don't|do not) have (?:access to )?real-?time\b|\bi cannot browse\b|\bcertainly! here(?:'s| is)\b|\bsure! here(?:'s| is)\b|\bof course! here(?:'s| is)\b|\babsolutely! here(?:'s| is)\b|\bhere(?:'s| is) (?:a|an|the|your) (?:revised|updated|rewritten|improved|polished|draft|sample|detailed|comprehensive|complete|\d+-word) (?:\w+ ){0,2}(?:article|blog post|version|rewrite|summary|overview|guide|breakdown|draft|essay|description|listing|response)\b(?:[^.!?\n]{0,60}[:.!])?/i;
  const SELF_REFERENCE_MEDIUM_RE = /\bi hope this helps\b|\blet me know if you(?:'d| would) like\b|\bwould you like me to\b|\bfeel free to (?:ask|adjust|modify|customi[sz]e|tweak)\b|\bif you(?:'d| would) like,? i can\b|\bplease note that\b/i;

  /* Markdown that survived a copy-paste from a chat window. */
  const MARKDOWN_LEAK_PATTERNS = [
    { id: 'bold', re: /\*\*[^*\n]{2,120}\*\*/g, label: 'literal **bold** markdown' },
    { id: 'heading', re: /(?:^|\n)\s*#{1,4}\s+\S/g, label: 'literal # heading markdown' },
    { id: 'fence', re: /```[\w-]*\n/g, label: 'literal ``` code fence' },
    { id: 'bullet', re: /(?:^|\n)\s*[-*]\s+\*\*/g, label: 'literal "- **" bullet markdown' },
    { id: 'citation', re: /【\d+(?::\d+)?†[^】]*】|\[oaicite:\d+\]|\bcontentReference\[oaicite:\d+\]/g, label: 'ChatGPT citation marker' },
  ];

  /* Stylometric lexicon. Tier 1 items are distinctive of LLM prose; tier 2
   * are frequent LLM connectives that humans also use. */
  const LEXICON_TIER1 = [
    /\bdelv(?:e|es|ed|ing)\b/gi, /\btapestry\b/gi, /\btestament to\b/gi, /\bmultifaceted\b/gi, /\bever-evolving\b/gi,
    /\bin today's (?:fast-paced|digital|ever-changing|dynamic|rapidly)\b/gi, /\bnavigat(?:e|ing) the (?:complexities|landscape|world|challenges)\b/gi,
    /\bit(?:'s| is) (?:important|worth|crucial|essential|vital) to (?:note|remember|understand|consider|mention|recognize|acknowledge)\b/gi,
    /\bin the realm of\b/gi, /\bgame-?changer\b/gi, /\bunleash(?:es|ed|ing)?\b/gi, /\bunlock(?:s|ed|ing)? the\b/gi, /\belevat(?:e|es|ing) your\b/gi,
    /\blet's (?:dive|delve|explore|embark|unpack|break)\b/gi, /\bdive (?:in|into|deep)\b/gi, /\bdeep dive\b/gi, /\bembark(?:s|ed|ing)? on\b/gi,
    /\bin conclusion,/gi, /\bin summary,/gi, /\bkey takeaways?\b/gi, /\bfinal thoughts\b/gi, /\bactionable insights?\b/gi, /\blook no further\b/gi,
    /\bhidden gems?\b/gi, /\bnestled (?:in|among|between|within)\b/gi, /\bin the heart of\b/gi, /\bstands as a\b/gi, /\bserves as a\b/gi,
    /\ba myriad of\b/gi, /\bmyriad\b/gi, /\bparamount\b/gi, /\bcommendable\b/gi, /\bmeticulous(?:ly)?\b/gi, /\bintricate(?:ly)?\b/gi,
    /\bseamless(?:ly)?\b/gi, /\brevolutioni[sz](?:e|es|ed|ing)\b/gi, /\btransformative\b/gi, /\bgroundbreaking\b/gi, /\bcutting-edge\b/gi,
    /\bunparalleled\b/gi, /\bbustling\b/gi, /\bvibrant\b/gi, /\bkaleidoscope\b/gi, /\bsymphony of\b/gi, /\blabyrinth(?:ine)?\b/gi, /\bbeacon of\b/gi,
    /\benigmatic\b/gi, /\bcaptivating\b/gi, /\bunwavering\b/gi, /\bunderscor(?:e|es|ed|ing)\b/gi, /\bpivotal\b/gi, /\bholistic\b/gi, /\bsynerg(?:y|ies|istic)\b/gi,
    /\bspearhead(?:s|ed|ing)?\b/gi, /\bharness(?:es|ed|ing)? the\b/gi, /\bfoster(?:s|ed|ing)? (?:a|an|the)\b/gi, /\bleverag(?:e|es|ed|ing)\b/gi,
    /\bstreamlin(?:e|es|ed|ing)\b/gi, /\bempower(?:s|ed|ing)?\b/gi, /\bwhether you(?:'re| are) an?\b/gi, /\bnot only\b[^.!?\n]{3,80}\bbut also\b/gi,
    /\bit(?:'s| is) not just about\b/gi, /\bthe world of\b/gi, /\ba wide (?:range|array|variety) of\b/gi, /\bplays? a (?:crucial|vital|significant|key|pivotal) role\b/gi,
    /\bat its core\b/gi, /\bthe landscape of\b/gi, /\bthe digital (?:age|landscape|era|realm)\b/gi, /\bin an era (?:of|where)\b/gi, /\bever-changing\b/gi,
    /\bfast-paced world\b/gi, /\b(?:comprehensive|ultimate) guide\b/gi, /\bin this (?:article|post|blog post|guide),? (?:we|you)(?:'ll| will)?\b/gi,
    /\b(?:this|the) (?:article|post|guide) (?:explores|delves|examines|outlines|covers|highlights)\b/gi, /\bwe(?:'ll| will) explore\b/gi, /\bwithout further ado\b/gi,
    /\bpicture this\b/gi, /\bimagine a world\b/gi, /\bin a world where\b/gi, /\bgone are the days\b/gi, /\bit(?:'s| is) no secret that\b/gi, /\brest assured\b/gi,
    /\bthat being said\b/gi, /\bit should be noted\b/gi, /\bneedless to say\b/gi, /\bin essence\b/gi, /\bto put it simply\b/gi, /\bthe bottom line\b/gi,
    /\bworth (?:noting|mentioning)\b/gi, /\bresonat(?:e|es|ed|ing)\b/gi, /\bnuanced\b/gi, /\binvaluable\b/gi, /\bindelible\b/gi, /\bsolidif(?:y|ies|ied|ying)\b/gi,
    /\breimagin(?:e|es|ed|ing)\b/gi, /\bboasts?\b/gi, /\bcrafted\b/gi, /\bbespoke\b/gi, /\bbeloved\b/gi, /\bthe importance of\b/gi, /\bshed(?:s|ding)? light on\b/gi,
    /\bgain(?:s|ed|ing)? (?:valuable )?insights?\b/gi, /\bcannot be overstated\b/gi, /\bstand(?:s)? out\b/gi, /\bsafe to say\b/gi, /\bprofound(?:ly)?\b/gi,
    /\bwhen it comes to\b/gi, /\bthe realm of\b/gi, /\bthrive(?:s|d)?\b/gi, /\btreasure trove\b/gi, /\bculminat(?:e|es|ed|ing)\b/gi, /\bin the ever-\w+\b/gi,
  ];
  const LEXICON_TIER2 = [
    /\bmoreover\b/gi, /\bfurthermore\b/gi, /\badditionally\b/gi, /\bultimately\b/gi, /\bimportantly\b/gi, /\bnotably\b/gi, /\bcrucially\b/gi,
    /\bundoubtedly\b/gi, /\bcertainly\b/gi, /\bindeed\b/gi, /\bas a result\b/gi, /\bin other words\b/gi, /\brobust\b/gi, /\brealm\b/gi, /\bcrucial\b/gi,
    /\bcomprehensive\b/gi, /\bensur(?:e|es|ing) that\b/gi, /\bessential\b/gi, /\bsignificant(?:ly)?\b/gi, /\benhanc(?:e|es|ed|ing)\b/gi, /\boptimi[sz](?:e|es|ed|ing)\b/gi,
    /\bfacilitat(?:e|es|ed|ing)\b/gi, /\butili[sz](?:e|es|ed|ing)\b/gi, /\bencompass(?:es|ed|ing)?\b/gi, /\binnovative\b/gi, /\bdynamic\b/gi, /\bvarious\b/gi,
    /\bexplor(?:e|es|ed|ing)\b/gi, /\bjourney\b/gi, /\blandscape\b/gi, /\bexperiences?\b/gi, /\bsolutions?\b/gi, /\bin today's\b/gi, /\bkey\b/gi, /\bvital\b/gi,
  ];

  /* Hosts that serve generated images. */
  const AI_IMAGE_HOSTS = [
    ['OpenAI / DALL·E storage', /oaidalleapiprodscus\.blob\.core\.windows\.net$|oaiusercontent\.com$|files\.oaiusercontent\.com$/i, 0.85],
    ['Midjourney CDN', /cdn\.midjourney\.com$|mj-gallery\.com$/i, 0.85],
    ['Replicate', /replicate\.delivery$|replicate\.com$/i, 0.6],
    ['fal.ai', /fal\.media$|fal\.ai$/i, 0.6],
    ['Lexica', /lexica\.art$/i, 0.7],
    ['Leonardo AI', /leonardo\.ai$/i, 0.7],
    ['Ideogram', /ideogram\.ai$/i, 0.75],
    ['NightCafe', /nightcafe\.studio$/i, 0.7],
    ['Pollinations', /pollinations\.ai$/i, 0.85],
    ['Civitai', /civitai\.com$/i, 0.6],
    ['Tensor.Art', /tensor\.art$/i, 0.65],
    ['Playground AI', /playground\.com$|playgroundai\.com$/i, 0.5],
    ['Meta AI imagine', /imagine\.meta\.com$/i, 0.75],
    ['Adobe Firefly', /firefly\.adobe\.com$/i, 0.7],
    ['Krea', /krea\.ai$/i, 0.6],
    ['SeaArt', /seaart\.ai$/i, 0.65],
    ['Recraft', /recraft\.ai$/i, 0.65],
    ['Grok / xAI images', /imgen\.x\.ai$|grok\.com$/i, 0.7],
    ['Google AI generated images', /\.googleusercontent\.com$/i, 0.0],
  ].filter((h) => h[2] > 0);

  const AI_IMAGE_FILENAME_RE = /dall[-_ ]?e|midjourney|\bmj_|stable[-_ ]?diffusion|\bsdxl\b|comfyui|ai[-_ ]?generated|generated[-_ ]?(?:image|by[-_ ]?ai)|\bimagen\b|firefly|leonardo|ideogram|flux[-_ ]?(?:dev|schnell|pro|kontext)|\bniji\b|novelai|nano[-_ ]?banana|gpt[-_ ]?image|\bgrok[-_ ]?image|\bsora[-_ ]/i;

  /* Business-trust placeholders left behind by templates and generators. */
  const PLACEHOLDER_PATTERNS = [
    { id: 'lorem', re: /\blorem ipsum\b/i, label: 'Lorem ipsum placeholder text' },
    { id: 'phone', re: /\(?\b555\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|\b\(?123\)?[-.\s]?456[-.\s]?7890\b|\b\(?000\)?[-.\s]?000[-.\s]?0000\b/, label: 'Placeholder phone number' },
    { id: 'email', re: /\b(?:info|hello|contact|support|name|email|you|user)@(?:example|yourcompany|yourdomain|company|domain|email|website|yoursite)\.(?:com|org|net)\b/i, label: 'Placeholder e-mail address' },
    { id: 'address', re: /\b123 (?:main|example|sample|your|anywhere|some) (?:st\.?|street|ave\.?|avenue|road|rd\.?)\b/i, label: 'Placeholder street address' },
    { id: 'company', re: /\b(?:your (?:company|business|brand) name|company name here|\[(?:company|business|brand|your) (?:name)?\]|acme (?:corp|inc|corporation)\b)/i, label: 'Placeholder company name' },
    { id: 'template', re: /\{\{\s*[\w.]+\s*\}\}|\[insert [^\]]{2,40}\]|\binsert (?:text|content|description|title) here\b/i, label: 'Unfilled template variable' },
    { id: 'year', re: /©\s?(?:20[0-9]{2}|\[year\]|\{year\})?\s?(?:your company|company name|brand name|all rights reserved\.? your)/i, label: 'Placeholder copyright line' },
  ];

  /* Text pasted out of a chat window uses U+2019, and every lexicon pattern
   * here is written with a straight apostrophe. Normalising one to the other
   * is a single-character substitution, so match offsets are preserved and
   * excerpts still line up with the original. */
  function normalizeQuotes(text) {
    return String(text || '').replace(/[\u2018\u2019\u02BC\u055A\uFF07]/g, "'");
  }

  function matchTools(list, text) {
    const hits = [];
    if (!text) return hits;
    for (const [name, re] of list) if (re.test(text)) hits.push(name);
    return hits;
  }

  /*
   * English patterns always run, because English disclosures turn up on
   * pages in every language. The page's own language is added on top.
   */
  function patternsFor(lang) {
    const extra = LEX && lang && lang !== 'en' ? LEX.get(lang) : null;
    return extra ? DISCLOSURE_PATTERNS.concat(extra.disclosures) : DISCLOSURE_PATTERNS;
  }

  const PER_PATTERN = 4;

  function findDisclosures(text, opts = {}) {
    const out = [];
    if (!text) return out;
    const haystack = normalizeQuotes(text);
    const max = opts.max || 25;
    /* Every pattern gets scanned. Capping the total mid-scan meant one phrase
     * repeated across a page could use up the budget before the patterns for
     * a human-authorship claim were ever tried, so the cap is per pattern
     * here and applied to the whole result only at the end. */
    for (const { level, re } of patternsFor(opts.lang)) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      let found = 0;
      let guard = 0;
      while ((m = g.exec(haystack)) && found < PER_PATTERN && guard++ < 500) {
        if (m[0].length === 0) { g.lastIndex++; continue; }
        const start = Math.max(0, m.index - 90);
        const end = Math.min(haystack.length, m.index + m[0].length + 90);
        const context = haystack.slice(start, end).replace(/\s+/g, ' ').trim();
        out.push({ level, match: m[0], context, scope: inferScope(context), index: m.index, end: m.index + m[0].length });
        found++;
      }
    }
    return finishDisclosures(out).slice(0, max);
  }

  /* "created with the help of AI" trips both an assistance pattern and a
   * generation pattern over the same words. The clause describes assistance,
   * so an overlapping generation match is dropped rather than upgrading the
   * verdict. Separate clauses do not overlap and both survive. */
  function suppressOverlaps(list) {
    const assisted = list.filter((d) => d.level === 'assisted');
    if (!assisted.length) return list;
    return list.filter((d) => {
      if (d.level !== 'generated') return true;
      return !assisted.some((a) => d.index < a.end && a.index < d.end);
    });
  }

  function finishDisclosures(list) {
    return dedupe(suppressOverlaps(list));
  }

  function inferScope(context) {
    let best = 'general';
    let bestPos = Infinity;
    for (const [scope, re] of SCOPE_HINTS) {
      const m = re.exec(context);
      if (m && m.index < bestPos) { best = scope; bestPos = m.index; }
    }
    return best;
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter((d) => {
      const k = d.level + '|' + d.match.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => a.index - b.index);
  }

  return {
    IPTC_DST_PREFIX,
    DIGITAL_SOURCE_TYPES,
    digitalSourceType,
    AI_IMAGE_TOOLS,
    AI_TEXT_TOOLS,
    AI_GENERATOR_RE,
    CAPTURE_GENERATOR_RE,
    CAMERA_MAKE_RE,
    GENERATOR_SOFTWARE_RE,
    SITE_FINGERPRINTS,
    CODE_AI_COMMENT_RE,
    CODE_AI_MARKER_RE,
    META_DISCLOSURE_NAME_RE,
    META_DISCLOSURE_TRUE_RE,
    META_DISCLOSURE_FALSE_RE,
    DISCLOSURE_PATTERNS,
    SELF_REFERENCE_STRONG_RE,
    SELF_REFERENCE_MEDIUM_RE,
    MARKDOWN_LEAK_PATTERNS,
    LEXICON_TIER1,
    LEXICON_TIER2,
    AI_IMAGE_HOSTS,
    AI_IMAGE_FILENAME_RE,
    PLACEHOLDER_PATTERNS,
    matchTools,
    normalizeQuotes,
    findDisclosures,
    patternsFor,
    suppressOverlaps,
    inferScope, EXCULPATORY_VERDICTS };
});

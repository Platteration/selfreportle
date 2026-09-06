/*
 * lib/attribution.js — which AI system most likely produced a piece of
 * content, and what is publicly documented about that system's tendencies
 * ("skews"). Attribution is only as strong as the evidence: embedded
 * metadata (confirmed) > a statement on the page (declared) > hosting or
 * style hints (inferred). Skew notes describe typical default behaviour
 * reported in public studies and vendor statements up to the review date;
 * they say nothing certain about a specific page.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.attribution = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const S = (typeof module === 'object' && typeof require === 'function') ? require('./signals.js') : root.SRL.signals;

  const REVIEWED = '2026-09';

  /* Skews that apply to essentially every large language model. */
  const GENERIC_TEXT_SKEWS = [
    { area: 'Accuracy', note: 'Fluent, confident text that can be factually wrong or cite sources that do not exist. Check names, numbers, quotes and references before relying on them.', basis: 'Widely documented; e.g. fabricated case law sanctioned in Mata v. Avianca (S.D.N.Y. 2023).' },
    { area: 'Recency', note: 'Knowledge stops at a training cut-off unless the tool browsed the web; recent prices, laws and events may be missing or stale.', basis: 'Vendor model cards.' },
    { area: 'Politics', note: 'Several 2023–2025 studies measured the default answers of major Western chat models as left-of-centre on political-orientation tests; vendors say they aim for neutrality and results vary by version and prompt.', basis: 'Rozado (2023, 2024); Motoki, Pinho Neto & Rodrigues (2023).' },
    { area: 'Sycophancy', note: 'Tends to agree with the framing it is given and to validate the user. Text that was "checked" by an assistant was not independently verified.', basis: 'Sharma et al. (Anthropic, 2023); OpenAI post-mortem on GPT-4o sycophancy (April 2025).' },
    { area: 'Style', note: 'Balanced, hedged, list-heavy prose that smooths over uncertainty and controversy; strong claims are often under-supported and marketing copy is persuasive without evidence.', basis: 'Stylometric corpus studies (e.g. Kobak et al. 2024; Liang et al. 2024).' },
    { area: 'Coverage', note: 'Training data is dominated by English and US sources; non-Western topics, minority languages and local specifics are thinner and more error-prone.', basis: 'Vendor documentation; multilingual benchmark gaps.' },
  ];

  /* Skews that apply to essentially every image generator. */
  const GENERIC_IMAGE_SKEWS = [
    { area: 'Representation', note: 'Prompts such as "CEO", "doctor" or a nationality tend to produce lighter-skinned men and national stereotypes; scenes default to Western settings.', basis: 'Bloomberg analysis of Stable Diffusion (2023); Rest of World analysis of Midjourney (2023).' },
    { area: 'Idealisation', note: 'Outputs are idealised and cinematic. A product, property, person or "team photo" may depict nothing that exists.', basis: 'General behaviour of diffusion models.' },
    { area: 'Fidelity', note: 'Text, hands, reflections, maps and fine structure are unreliable; an image is not documentary evidence of anything.', basis: 'General behaviour of diffusion models.' },
    { area: 'Provenance', note: 'Models are trained on scraped web images; style imitation and copyright litigation are ongoing, and metadata can be stripped on re-upload.', basis: 'Andersen v. Stability AI (2023–); Getty v. Stability AI (2023–).' },
  ];

  const GENERIC_SITE_SKEWS = [
    { area: 'Legitimacy', note: 'A polished storefront now costs minutes. Check company registration, imprint / legal notice, physical address, reviews off-site and the payment processor before paying.', basis: 'Consumer-protection guidance on AI-built scam sites (2024–2026).' },
    { area: 'Content', note: 'Copy, testimonials, team members and statistics may be invented placeholders that were never edited.', basis: 'Typical generator output.' },
    { area: 'Security', note: 'Generated apps often ship with default configurations; 2025 reports found many prompt-built apps exposing user data through misconfigured database access rules. Be cautious with personal data and payments.', basis: 'Security-researcher disclosures on Lovable-built apps (2025).' },
  ];

  /* Vendor / product profiles. `match` regexes are applied to evidence
   * strings (claim generators, software agents, signer names, creator tools,
   * captions, disclosures, builder names). */
  const PROFILES = [
    {
      id: 'openai', name: 'OpenAI (ChatGPT, GPT models, DALL·E, Sora)', vendor: 'OpenAI', country: 'United States', kinds: ['text', 'image', 'video', 'code'],
      match: /openai|chat\s?gpt|\bgpt[-\s]?(?:image|\d|o\d|4o)|dall[·\-\s]?e|\bsora\b|oaicite|oaiusercontent/i,
      marking: 'DALL·E 3, GPT image and Sora outputs carry C2PA Content Credentials (Sora also a visible watermark). ChatGPT text has no public watermark; leaked citation markers (【…†…】) and chat phrasing are the usual tells.',
      skews: [
        { area: 'Sycophancy', note: 'An April 2025 GPT-4o update was rolled back by OpenAI for being excessively agreeable and flattering; the tendency to validate the user persists to a lesser degree.', basis: 'OpenAI, "Sycophancy in GPT-4o" (April 2025).' },
        { area: 'Politics', note: 'Measured left-of-centre on political tests in several academic studies of ChatGPT; OpenAI publishes its own bias evaluations and says newer models are closer to neutral.', basis: 'Rozado (2023); Motoki et al. (2023); OpenAI "Defining and evaluating political bias" (2025).' },
        { area: 'Style', note: 'The "delve / tapestry / testament" vocabulary, tricolons and heavy em-dash use that spread through the web in 2023–2025 are strongly associated with GPT-family outputs.', basis: 'Kobak et al. (2024) on scientific abstracts; Liang et al. (2024).' },
        { area: 'Images', note: 'DALL·E / GPT image output leans to glossy, saturated, symmetrical compositions and applies content policies that refuse public figures and some styles.', basis: 'OpenAI usage policies; community documentation.' },
      ],
    },
    {
      id: 'anthropic', name: 'Anthropic (Claude)', vendor: 'Anthropic', country: 'United States', kinds: ['text', 'code', 'site'],
      match: /anthropic|\bclaude\b/i,
      marking: 'No image generation. Claude text has no public watermark; Claude-built pages published as "Artifacts" live on claude.site.',
      skews: [
        { area: 'Caution', note: 'Trained with "constitutional AI"; tends to hedge, add caveats and decline or soften sensitive requests more than some peers, which can read as evasive.', basis: 'Anthropic model documentation and usage policy.' },
        { area: 'Politics', note: 'Anthropic publishes an "even-handedness" evaluation and targets balanced treatment of political topics; independent studies still place default outputs slightly left of centre, as with most Western models.', basis: 'Anthropic, political even-handedness evaluation (2025); Rozado (2024).' },
        { area: 'Style', note: 'Structured, thorough, often long answers with summaries and bullet lists; agreeable tone. Widely used inside coding and site-building tools (Lovable, Bolt, Replit Agent, Cursor).', basis: 'Vendor statements of those products.' },
      ],
    },
    {
      id: 'google', name: 'Google (Gemini, Imagen, Veo)', vendor: 'Google / DeepMind', country: 'United States', kinds: ['text', 'image', 'video', 'code'],
      match: /\bgemini\b|\bimagen\b|\bveo\b|google\s?(?:ai|deepmind|labs)|nano[\s-]?banana|synthid|\bbard\b/i,
      marking: 'Imagen, Gemini image and Veo outputs carry an invisible SynthID watermark (verifiable only by Google) and, in many products, C2PA Content Credentials. Gemini text may carry SynthID-Text, likewise not publicly verifiable.',
      skews: [
        { area: 'Representation', note: 'In February 2024 Google paused Gemini image generation after it inserted demographic diversity into historically specific prompts; later versions were retuned. Expect deliberate demographic balancing.', basis: 'Google statement, 22 Feb 2024.' },
        { area: 'Ecosystem', note: 'Grounds answers in Google Search and integrates with Google products; results can favour that ecosystem and inherit search-ranking biases.', basis: 'Product design.' },
        { area: 'Caution', note: 'Refuses or deflects many election and political questions by policy in several regions.', basis: 'Google election-content policies (2024–2025).' },
      ],
    },
    {
      id: 'meta', name: 'Meta AI (Llama, Imagine with Meta)', vendor: 'Meta', country: 'United States', kinds: ['text', 'image'],
      match: /\bmeta\s?ai\b|\bllama[\s-]?\d|imagine\.meta|\bemu\b/i,
      marking: 'Meta AI images carry "Imagined with AI" labels, IPTC digital-source-type metadata and C2PA credentials on Meta platforms; Llama text (open weights) has no watermark.',
      skews: [
        { area: 'Politics', note: 'With Llama 4 (April 2025) Meta said it had tuned the model to counter what it called a historical left-leaning bias in LLMs and to answer more contentious questions; open weights mean third parties retune it freely.', basis: 'Meta, Llama 4 release post (April 2025).' },
        { area: 'Platform', note: 'Trained on public Facebook and Instagram content in many regions (opt-out contested in the EU); responses reflect social-media discourse.', basis: 'Meta privacy notices (2024–2025); EU regulator actions.' },
      ],
    },
    {
      id: 'xai', name: 'xAI (Grok, Grok Imagine / Aurora)', vendor: 'xAI', country: 'United States', kinds: ['text', 'image', 'video'],
      match: /\bgrok\b|\bxai\b|imgen\.x\.ai/i,
      marking: 'Grok text has no watermark; Grok images carry little or no provenance metadata.',
      skews: [
        { area: 'Politics', note: 'Marketed as "anti-woke" and less restricted; in May 2025 it inserted "white genocide" claims about South Africa into unrelated answers (xAI blamed an unauthorised prompt change) and in July 2025 produced antisemitic content for which xAI apologised. System prompts have been repeatedly edited in ideological directions.', basis: 'xAI statements, May and July 2025; contemporaneous reporting.' },
        { area: 'Source', note: 'Draws on live posts from X, so answers mirror the platform\'s discourse and its verification problems.', basis: 'Product design.' },
        { area: 'Images', note: 'Image generation has permitted public figures and deepfake-like content that other vendors block; treat depictions of real people as unreliable.', basis: 'Reporting on Grok image generation (2024–2025).' },
      ],
    },
    {
      id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek (Hangzhou)', country: 'China', kinds: ['text', 'code'],
      match: /deepseek/i,
      marking: 'No watermark; open weights are widely re-hosted, so the operator may not be DeepSeek.',
      skews: [
        { area: 'Censorship', note: 'Hosted models comply with PRC content rules: they decline or give state-aligned answers on topics such as Tiananmen 1989, Taiwan, Xinjiang, Tibet and Chinese leadership. Re-hosted open weights show the same tendency to a lesser degree.', basis: 'Multiple independent audits (2025).' },
        { area: 'Data', note: 'The official app stores data in China; Italy blocked it in January 2025 and several governments barred it on official devices.', basis: 'Garante (Italy) order, Jan 2025; government advisories 2025.' },
      ],
    },
    {
      id: 'alibaba', name: 'Alibaba Qwen', vendor: 'Alibaba Cloud', country: 'China', kinds: ['text', 'image', 'code'],
      match: /\bqwen\b|alibaba/i,
      marking: 'No watermark; open weights are widely re-hosted.',
      skews: [
        { area: 'Censorship', note: 'Aligned with PRC content regulation on politically sensitive topics, like other mainland-Chinese models.', basis: 'Independent audits (2025).' },
      ],
    },
    {
      id: 'mistral', name: 'Mistral AI', vendor: 'Mistral AI', country: 'France', kinds: ['text', 'code'],
      match: /\bmistral\b/i,
      marking: 'No watermark; open-weight models are widely re-hosted.',
      skews: [
        { area: 'Moderation', note: 'Historically lighter default safety tuning than US labs, so outputs can be blunter and less filtered; strong in European languages.', basis: 'Model cards; independent evaluations (2024–2025).' },
      ],
    },
    {
      id: 'microsoft', name: 'Microsoft Copilot / Designer / Bing Image Creator', vendor: 'Microsoft', country: 'United States', kinds: ['text', 'image', 'code'],
      match: /copilot|microsoft\s?designer|bing\s?image|image creator/i,
      marking: 'Designer and Bing Image Creator output carries C2PA Content Credentials. Copilot text is built on OpenAI models.',
      skews: [
        { area: 'Commercial', note: 'Consumer Copilot answers are grounded in Bing and include advertising and product links; treat recommendations as sponsored-adjacent.', basis: 'Microsoft advertising documentation for Copilot.' },
        { area: 'Inherited', note: 'Shares the OpenAI model tendencies (see OpenAI) with an extra Microsoft moderation layer that can refuse more.', basis: 'Product architecture.' },
      ],
    },
    {
      id: 'perplexity', name: 'Perplexity', vendor: 'Perplexity AI', country: 'United States', kinds: ['text'],
      match: /perplexity/i,
      marking: 'Search-grounded answers with citations; no watermark.',
      skews: [
        { area: 'Sourcing', note: 'Cites sources, but publishers (Forbes, Wired, Dow Jones, NYT) accused it in 2024–2025 of reproducing articles and ignoring crawling restrictions; citations can be paraphrased loosely. Advertising was introduced in late 2024.', basis: 'Publisher complaints and lawsuits, 2024–2025.' },
      ],
    },
    {
      id: 'midjourney', name: 'Midjourney', vendor: 'Midjourney Inc.', country: 'United States', kinds: ['image', 'video'],
      match: /midjourney|\bniji\b|mj-gallery|cdn\.midjourney/i,
      marking: 'Writes the prompt and job ID into image descriptions and IPTC digital-source-type metadata; did not attach C2PA credentials at the time of review.',
      skews: [
        { area: 'Aesthetic', note: 'Strong house style: painterly, cinematic, warm, highly idealised. Real places and people come out prettier and more uniform than reality.', basis: 'Community documentation.' },
        { area: 'Representation', note: 'A 2023 analysis found national prompts reduced to stereotypes (e.g. "an Indian person" almost always an older man in a turban).', basis: 'Rest of World, "How AI reduces the world to stereotypes" (2023).' },
        { area: 'Provenance', note: 'Trained on scraped images without licences; sued by artists (2023) and by Disney and Universal (June 2025) over copyrighted characters.', basis: 'Andersen v. Stability AI et al.; Disney/Universal v. Midjourney (2025).' },
      ],
    },
    {
      id: 'stability', name: 'Stable Diffusion family (Stability AI and community fine-tunes)', vendor: 'Stability AI / open-source community', country: 'United Kingdom / worldwide', kinds: ['image', 'video'],
      match: /stable[\s_-]?diffusion|stability|\bsdxl\b|automatic1111|a1111|sd-webui|comfyui|invokeai|fooocus|novelai|civitai|tensor\.art|draw\s?things|diffusionbee|dreamstudio/i,
      marking: 'Open weights; local front-ends (AUTOMATIC1111, ComfyUI, InvokeAI, Fooocus, NovelAI) embed generation parameters in PNG text or EXIF, which is what this extension reads. Fine-tuned checkpoints ("Model:" in the parameters) often come from Civitai.',
      skews: [
        { area: 'Representation', note: 'A 2023 analysis of 5,000 Stable Diffusion images found occupations and traits skewed by skin tone and gender more strongly than real-world statistics.', basis: 'Bloomberg, "Humans are biased. Generative AI is even worse" (2023).' },
        { area: 'Moderation', note: 'No content filter is enforced on local use; community checkpoints are frequently tuned for photorealistic people, adult content and specific styles, so realistic fakes are cheap.', basis: 'Open-weights ecosystem.' },
        { area: 'Provenance', note: 'Trained on LAION web scrapes; subject to Getty Images and artists\' lawsuits.', basis: 'Getty v. Stability AI (2023–); Andersen v. Stability AI (2023–).' },
      ],
    },
    {
      id: 'bfl', name: 'Black Forest Labs (FLUX)', vendor: 'Black Forest Labs', country: 'Germany', kinds: ['image', 'video'],
      match: /black\s?forest|\bflux\b/i,
      marking: 'Open and API models; no mandatory watermark or credentials. Also the engine behind Grok image generation in 2024–2025.',
      skews: [
        { area: 'Realism', note: 'Tuned for photorealism and legible text, so outputs pass casual inspection more easily than older models.', basis: 'Model documentation and community benchmarks.' },
        { area: 'Representation', note: 'Shares the dataset-driven demographic and stereotype defaults documented for diffusion models generally.', basis: 'See generic image skews.' },
      ],
    },
    {
      id: 'adobe', name: 'Adobe Firefly / Photoshop generative features', vendor: 'Adobe', country: 'United States', kinds: ['image', 'video'],
      match: /firefly|adobe|generative\s?(?:fill|expand|remove)|photoshop/i,
      marking: 'Attaches C2PA Content Credentials to all Firefly output and to generative edits in Photoshop; writes IPTC digital-source-type metadata.',
      skews: [
        { area: 'Training', note: 'Trained on Adobe Stock, openly licensed and public-domain content and marketed as "commercially safe"; contributors have disputed how their stock images were used.', basis: 'Adobe Firefly documentation; contributor reporting (2023–2024).' },
        { area: 'Moderation', note: 'Conservative content filters; refuses many prompts involving public figures, brands or violence, so output tends toward stock-photo neutrality.', basis: 'Adobe generative AI guidelines.' },
      ],
    },
    {
      id: 'ideogram', name: 'Ideogram', vendor: 'Ideogram AI', country: 'Canada', kinds: ['image'],
      match: /ideogram/i, marking: 'No C2PA at time of review.',
      skews: [{ area: 'Use', note: 'Specialised in legible text and logos, so generated signage, packaging and posters can look authentic.', basis: 'Product positioning.' }],
    },
    {
      id: 'leonardo', name: 'Leonardo.Ai (Canva)', vendor: 'Canva', country: 'Australia', kinds: ['image', 'video'],
      match: /leonardo|canva|magic\s?(?:media|studio|design)/i, marking: 'Canva attaches C2PA credentials to some AI output; Leonardo output generally carries none.',
      skews: [{ area: 'Use', note: 'Widely used for game assets, marketing visuals and product mock-ups; stock-like polish.', basis: 'Product positioning.' }],
    },
    {
      id: 'runway', name: 'Runway', vendor: 'Runway', country: 'United States', kinds: ['video', 'image'],
      match: /runway/i, marking: 'Runway is a C2PA member; credentials on some exports.',
      skews: [{ area: 'Provenance', note: 'Reported in 2024 to have trained on scraped YouTube and pirated film content.', basis: '404 Media reporting (2024).' }],
    },
    {
      id: 'kling', name: 'Kling (Kuaishou)', vendor: 'Kuaishou', country: 'China', kinds: ['video', 'image'],
      match: /\bkling\b|kuaishou/i, marking: 'Visible watermark on free tier; no C2PA at time of review.',
      skews: [{ area: 'Censorship', note: 'Subject to PRC content regulation; refuses politically sensitive subjects.', basis: 'Vendor terms; independent tests (2024–2025).' }],
    },
    {
      id: 'lovable', name: 'Lovable', vendor: 'Lovable (Stockholm)', country: 'Sweden', kinds: ['site'],
      match: /lovable|gptengineer|gpteng\.co/i,
      marking: 'Generated apps expose data-lov-* attributes and load gptengineer.js; typically React + Tailwind + Supabase.',
      skews: [
        { area: 'Model', note: 'Builds primarily on Anthropic Claude models (with OpenAI and Google models for some tasks), so the copy inherits those models\' tendencies.', basis: 'Lovable public statements (2024–2025).' },
        { area: 'Security', note: 'In 2025 researchers found many published Lovable apps with database access rules that exposed user records; Lovable later added a security scanner. Treat forms, logins and payments with caution.', basis: 'Security-researcher disclosures (2025).' },
      ],
    },
    {
      id: 'v0', name: 'v0 by Vercel', vendor: 'Vercel', country: 'United States', kinds: ['site'],
      match: /\bv0\b/i, marking: 'Generated UIs use shadcn/ui, Tailwind and data-v0-* markers; apps are hosted on *.v0.app / *.vercel.app.',
      skews: [{ area: 'Model', note: 'Vercel\'s composite model is built on OpenAI and Anthropic base models; expect their text tendencies.', basis: 'Vercel engineering posts (2024–2025).' }],
    },
    {
      id: 'bolt', name: 'Bolt.new (StackBlitz)', vendor: 'StackBlitz', country: 'United States', kinds: ['site'],
      match: /\bbolt(?:\.new|\.host)?\b/i, marking: 'Apps hosted on *.bolt.host; "Made with Bolt" badge is optional.',
      skews: [{ area: 'Model', note: 'Built primarily on Anthropic Claude models.', basis: 'StackBlitz public statements (2024–2025).' }],
    },
    {
      id: 'replit', name: 'Replit Agent', vendor: 'Replit', country: 'United States', kinds: ['site', 'code'],
      match: /replit/i, marking: 'Apps hosted on *.replit.app; hosting alone does not prove AI generation.',
      skews: [{ area: 'Model', note: 'Replit Agent is built primarily on Anthropic Claude models; in July 2025 an agent famously deleted a production database during a "code freeze", illustrating the autonomy risk of agent-built apps.', basis: 'Replit statements (2025).' }],
    },
    {
      id: 'base44', name: 'Base44 (Wix)', vendor: 'Wix', country: 'Israel', kinds: ['site'],
      match: /base44/i, marking: 'Apps hosted on *.base44.app.',
      skews: [{ area: 'Model', note: 'Uses several frontier models; acquired by Wix in 2025.', basis: 'Wix announcement (June 2025).' }],
    },
    {
      id: 'manus', name: 'Manus', vendor: 'Butterfly Effect (Manus)', country: 'Singapore / China', kinds: ['site', 'text'],
      match: /\bmanus\b/i, marking: 'Sites published on *.manus.space.',
      skews: [{ area: 'Model', note: 'Agent built on Anthropic Claude and Alibaba Qwen models; company relocated from China to Singapore in 2025.', basis: 'Manus statements and reporting (2025).' }],
    },
    {
      id: 'durable', name: 'Durable', vendor: 'Durable', country: 'United States', kinds: ['site'],
      match: /durable/i, marking: 'One-prompt small-business sites; typically OpenAI-generated copy.',
      skews: [{ area: 'Content', note: 'Generates business names, copy, stock imagery and testimonials automatically; verify anything factual.', basis: 'Product design.' }],
    },
    {
      id: '10web', name: '10Web AI Builder', vendor: '10Web', country: 'United States / Armenia', kinds: ['site'],
      match: /10web/i, marking: 'WordPress sites with 10Web plugins; copy generated with OpenAI models.',
      skews: [{ area: 'Content', note: 'Copy and imagery are generated from a short description; placeholder content is common.', basis: 'Product design.' }],
    },
    {
      id: 'cursor', name: 'AI coding assistants (Cursor, Windsurf, Codex, Devin, Copilot)', vendor: 'various', country: 'United States', kinds: ['code'],
      match: /cursor|windsurf|codex|devin|tabnine|codeium|codewhisperer|amazon\s?q/i, marking: 'Only visible when a comment credits the tool.',
      skews: [{ area: 'Code', note: 'Generated code favours plausible-looking defaults, may invent APIs or packages ("slopsquatting" risk) and often omits input validation and access controls.', basis: 'Academic studies of AI-generated code security (2023–2025).' }],
    },
  ];

  const byId = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

  function profile(id) { return byId[id] || null; }

  function matchProfile(text, kinds) {
    if (!text) return null;
    for (const p of PROFILES) {
      if (kinds && !p.kinds.some((k) => kinds.includes(k))) continue;
      if (p.match.test(text)) return p;
    }
    return null;
  }

  /* Software strings like "ComfyUI", "AUTOMATIC1111" say which front-end
   * was used; the checkpoint name in SD parameters says which fine-tune. */
  function refineStable(evidence) {
    const front = /comfyui|class_type|KSampler/i.test(evidence) ? 'ComfyUI' : /automatic1111|a1111|sd-webui/i.test(evidence) ? 'AUTOMATIC1111 WebUI' : /invokeai/i.test(evidence) ? 'InvokeAI' : /fooocus/i.test(evidence) ? 'Fooocus' : /novelai|"uc"\s*:/i.test(evidence) ? 'NovelAI' : null;
    const model = /\bModel:\s*([^,\n]{2,60})/i.exec(evidence) || /"(?:base_model|ckpt_name|model)"\s*:\s*"([^"]{2,60})"/i.exec(evidence);
    const parts = [];
    if (front) parts.push('front-end ' + front);
    if (model) parts.push('checkpoint "' + model[1].trim() + '"');
    return parts.join(', ');
  }

  function make(p, confidence, evidence, extra) {
    return { id: p.id, name: p.name, vendor: p.vendor, country: p.country, confidence, evidence: String(evidence || '').slice(0, 200), detail: extra || '', marking: p.marking, skews: p.skews };
  }

  /* ---- images ----------------------------------------------------------- */

  function attributeImage(signals, metadata) {
    const anyAI = (signals || []).some((s) => ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected'].includes(s.verdict));
    if (!anyAI) return null;
    const m = metadata || {};
    const c2 = m.c2pa || {};
    const strong = [c2.claimGenerator, ...(c2.claimGeneratorInfo || []), ...(c2.softwareAgents || []), ...(c2.signerNames || [])].filter(Boolean).join(' | ');
    const xmp = m.xmp || {};
    const exif = m.exif || {};
    const png = m.pngText || {};
    const embedded = [xmp.creatorTool, ...(xmp.softwareAgents || []), xmp.credit, xmp.description, exif.software, exif.userComment, exif.imageDescription, ...Object.keys(png), ...Object.values(png), ...(m.comments || [])].filter(Boolean).join(' | ');

    let p = matchProfile(strong, ['image', 'video']);
    if (p) return make(p, 'confirmed', 'Content Credentials: ' + strong);

    const sdMarkers = /Steps:\s*\d+|class_type|KSampler|"uc"\s*:|invokeai|fooocus|\bparameters\b/i.test(embedded);
    p = matchProfile(embedded, ['image', 'video']) || (sdMarkers ? byId.stability : null);
    if (p) return make(p, 'confirmed', 'Embedded metadata: ' + embedded.slice(0, 160), p.id === 'stability' ? refineStable(embedded) : '');

    const caption = (signals || []).filter((s) => /^caption/.test(s.id)).map((s) => s.detail).join(' ');
    p = matchProfile(caption, ['image', 'video']);
    if (p) return make(p, 'declared', 'Caption / alt text: ' + caption.slice(0, 160));

    const host = (signals || []).find((s) => s.id === 'host');
    p = host && matchProfile(host.label + ' ' + host.detail, ['image', 'video']);
    if (p) return make(p, 'inferred', 'Served from ' + host.detail);

    const file = (signals || []).find((s) => s.id === 'filename' || s.id === 'path');
    p = file && matchProfile(file.detail, ['image', 'video']);
    if (p) return make(p, 'inferred', 'File name: ' + file.detail);

    return { id: null, name: 'Unidentified image generator', confidence: 'unknown', evidence: 'AI markers present but no tool named', skews: GENERIC_IMAGE_SKEWS };
  }

  /* ---- text ------------------------------------------------------------- */

  function attributeText(textResult, pageHints) {
    const t = textResult || {};
    const blocks = t.flagged || [];
    const allSignals = [...((t.page && t.page.signals) || []), ...blocks.flatMap((b) => b.signals || [])];
    const disclosures = [...(t.disclosures || []), ...((pageHints && pageHints.disclosures) || [])];

    // 1. A disclosure or meta tag names the tool.
    const declared = disclosures.map((d) => d.context || d.match || '').join(' | ');
    let p = matchProfile(declared, ['text', 'code', 'site']);
    if (p) return make(p, 'declared', 'Disclosure: ' + declared.slice(0, 160));
    const meta = (pageHints && pageHints.metaText) || '';
    p = matchProfile(meta, ['text', 'code', 'site']);
    if (p) return make(p, 'declared', 'Page metadata: ' + meta.slice(0, 160));

    // 2. Product-specific artefacts.
    const md = allSignals.find((s) => s.id === 'markdown-leak' && /citation/i.test(s.detail || ''));
    if (md) return make(byId.openai, 'confirmed', 'ChatGPT citation markers left in the text');
    const self = allSignals.find((s) => s.id === 'self-reference');
    if (self && /chat\s?gpt|openai|gpt/i.test(self.detail || '')) return make(byId.openai, 'confirmed', self.detail);

    // 3. Weak stylistic hints, explicitly labelled as guesses.
    const lex = allSignals.find((s) => s.id === 'lexicon');
    const anyAI = ['ai', 'likely-ai', 'possible-ai', 'ai-disclosed', 'ai-assisted-disclosed'].includes(t.verdict);
    if (!anyAI) return null;
    const hints = [];
    if (lex && /delve|tapestry|testament|multifaceted/i.test(lex.detail || '')) hints.push('"delve / tapestry / testament" vocabulary is most associated with GPT-family models in corpus studies');
    if (allSignals.some((s) => s.id === 'em-dash')) hints.push('heavy em-dash use is characteristic of 2024–2025 GPT-family output');
    if (allSignals.some((s) => s.id === 'narrow-nbsp')) hints.push('narrow no-break spaces appeared in OpenAI o3 / o4-mini output in spring 2025');
    if (self) hints.push('assistant phrasing ("Certainly! Here\'s…") is typical of chat assistants generally');
    if (hints.length >= 1 && hints.some((h) => /GPT|OpenAI/.test(h))) {
      const r = make(byId.openai, 'inferred', hints.join('; '));
      r.name = 'Possibly OpenAI GPT-family (style only)';
      return r;
    }
    return { id: null, name: 'Unidentified large language model', confidence: 'unknown', evidence: hints.join('; ') || 'AI indicators present but no tool named', skews: GENERIC_TEXT_SKEWS };
  }

  /* ---- site ------------------------------------------------------------- */

  function attributeSite(siteResult, snapshot) {
    const s = siteResult || {};
    if (s.builder && s.builder.kind === 'ai-builder') {
      const p = matchProfile(s.builder.name, ['site']) || byId.lovable;
      const r = make(p, 'confirmed', 'Generator fingerprint: ' + s.builder.name);
      // A builder is itself built on a model vendor; surface that too.
      const modelSkew = (p.skews || []).find((k) => k.area === 'Model');
      if (modelSkew) r.detail = modelSkew.note;
      return r;
    }
    const code = (s.signals || []).filter((x) => x.id === 'code-comment' || x.id === 'visible-site-disclosure' || x.id === 'meta-ai' || x.id === 'jsonld-creator').map((x) => x.detail).join(' | ');
    let p = matchProfile(code, ['site', 'code', 'text']);
    if (p) return make(p, code.includes('comment') ? 'confirmed' : 'declared', code.slice(0, 160));
    if (s.builder && s.builder.kind === 'ai-host') {
      p = matchProfile(s.builder.name, ['site']);
      if (p) return make(p, 'inferred', 'Hosted on ' + s.builder.name);
    }
    if (['ai-built', 'ai-disclosed', 'ai-assisted'].includes(s.verdict)) return { id: null, name: 'Unidentified AI tool', confidence: 'unknown', evidence: 'AI involvement indicated but no tool named', skews: GENERIC_SITE_SKEWS };
    return null;
  }

  /* Skews to show for a given attribution: the product's own, followed by
   * the generic ones for that content kind (deduplicated by area). */
  function skewsFor(attr, kind) {
    const generic = kind === 'image' ? GENERIC_IMAGE_SKEWS : kind === 'site' ? GENERIC_SITE_SKEWS : GENERIC_TEXT_SKEWS;
    if (!attr) return [];
    const own = attr.skews || [];
    const seen = new Set(own.map((k) => k.area));
    return [...own.map((k) => ({ ...k, source: 'product' })), ...generic.filter((k) => !seen.has(k.area)).map((k) => ({ ...k, source: 'generic' }))];
  }

  const CONFIDENCE_LABEL = { confirmed: 'confirmed by embedded metadata or artefacts', declared: 'declared on the page', inferred: 'inferred from hosting or style (weak)', unknown: 'tool not identified' };

  return { REVIEWED, PROFILES, GENERIC_TEXT_SKEWS, GENERIC_IMAGE_SKEWS, GENERIC_SITE_SKEWS, CONFIDENCE_LABEL, profile, matchProfile, attributeImage, attributeText, attributeSite, skewsFor };
});

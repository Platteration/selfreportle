# Text detection research

Catalogue reviewed on **2026-10-12** for a requested publication window beginning
**2021-10-12**. The verified works below were published in **2023–2025**. The review
date does not mean that every model released through 2026 has been studied or that
every publication from the five-year window has been reviewed.

The extension ships a local catalogue in `lib/research.js`; using it requires no
network request, model download, API credential or transmission of page text.

## Vocabulary evidence

[Kobak et al., Science Advances (2025)](https://github.com/berenslab/llm-excess-vocab)
studied changes in vocabulary across biomedical abstracts. The authors release
[word annotations](https://github.com/berenslab/llm-excess-vocab/blob/main/results/excess_words.csv)
and an [analysis notebook](https://github.com/berenslab/llm-excess-vocab/blob/main/scripts/03-figures.ipynb)
whose saved outputs identify excess **style words in 2024**. This is evidence of
population-level shifts associated with LLM-assisted writing in that domain.
It is not an individual-document authorship test.

The catalogue curates 16 word families from that notebook output: delve, showcase,
underscore, bolster, burgeon, delineate, elucidate, encapsulate, endeavor,
intricacy, meticulous, multifaceted, nuance, noteworthy, pivotal and realm.
Only inflections present in that output are included. A family name does not
promise that every inflection matches. Repetition and inflections of the same
family are not independent evidence.

Humans use all of these words. A lone word, generic idiom, plain vocabulary,
consistent sentence length or formal academic style must not be treated as proof
of AI authorship. Use diverse lexical matches as weak corroboration alongside
other evidence, and describe their source and limitations. Do not label the score
as an empirical authorship probability or use these words to identify a vendor or
model. Thresholds and weights chosen for the extension are engineering choices,
not accuracy measurements established by these papers.

## Sources and practical limits

| Source | Verified scope | Implication |
| --- | --- | --- |
| [Excess vocabulary, 2025](https://github.com/berenslab/llm-excess-vocab) | Biomedical abstract vocabulary shifts and released 2024 style-word output. | A small cited English vocabulary catalogue can support cautious corroboration; domain-wide changes do not establish a particular document's author. |
| [GPT detector bias, 2023](https://github.com/Weixin-Liang/ChatGPT-Detector-Bias) | Seven detectors, native and non-native English writing, and editing prompts. | Non-native English writing with constrained linguistic expression can be falsely flagged; editing can defeat detection. |
| [M4, EACL March 2024](https://github.com/mbzuai-nlp/M4) | Multiple generators, domains and languages, including time-domain changes. | Unseen models and domains reduce generalization. Do not assume English vocabulary rules transfer to other languages. |
| [RAID, ACL August 2024](https://github.com/liamdugan/raid) | GPT-2/3/4, ChatGPT, Llama 2, Cohere, MPT and Mistral across domains, sampling settings and attacks. | Decoding settings, repetition penalties and edits affect detection. Dataset coverage is not measured extension accuracy. |
| [LLM watermarking, 2023](https://github.com/jwkirchenbauer/lm-watermarking) | A generation-time token-distribution watermark and matching detector. | Detection requires the compatible vocabulary, tokenizer, seeding scheme and key; it is not a search for visible or invisible special characters. |
| [DetectGPT, 2023](https://github.com/eric-mitchell/detect-gpt) | Released model-based probability-curvature experiments. | Local word and rhythm heuristics do not implement DetectGPT, perplexity or a trained model classifier. |

Common assistant phrases and copied chat markup are contextual clues. A quoted
assistant response, an article explaining AI, Markdown written by a human or a
claimed model identity can contain the same text. A copied artifact can suggest
its originating format without authenticating the content's authorship.

Invisible Unicode sequences can indicate formatting, a hidden payload or an
obfuscation technique. They cannot by themselves verify that an LLM produced the
text. Statistical watermarks work on token selection; provider-specific schemes
need their compatible verification mechanism and configuration. The extension
does not verify those schemes, and the absence of a visible artifact does not
establish human authorship.

The reviewed researcher-owned repositories and released analysis outputs were
retrieved over HTTPS with TLS verification. Paper URLs in `lib/research.js` are
references supplied by those repositories. Direct arXiv access was denied by the
environment proxy; paper full text was not retrieved from arXiv for this review.
The catalogue therefore cites the inspected repositories and does not imply a
complete full-text literature search.

## Documented product formats

`lib/model-catalog.js` also records explicit model identifiers and primary
documentation for text, code, image, video and audio products. These identify a
product only when used in a generation/assistance declaration or a dedicated
generator/model metadata field. Ordinary article or caption mentions do not
establish that the content was generated by the named product. Generic words and
personal names require a qualified product name or a documented model version.
The existing idiom and multilingual lexicons remain contextual heuristics; the
reviewed English biomedical vocabulary is not translated into new languages.

| Format | Inspected primary definition | Interpretation |
| --- | --- | --- |
| Llama header and turn terminator | [Meta tokenizer](https://github.com/meta-llama/llama3/blob/main/llama/tokenizer.py) | A compatible Llama-family conversation format, including derivatives. |
| Gemma model turn and end-of-turn | [Google example](https://github.com/google/gemma_pytorch/blob/main/scripts/run_multimodal.py) | A compatible Gemma-family turn format. |
| Harmony assistant header and closing marker | [OpenAI encoding definitions](https://github.com/openai/harmony/blob/main/src/encoding.rs) | A Harmony-compatible response format, which other software can reuse. |
| MiniMax assistant and sentence terminator | [MiniMax template](https://github.com/MiniMax-AI/MiniMax-M1/blob/main/tokenizer_config.json) | A compatible MiniMax-family serialized turn. |
| Kimi tool section and call delimiters | [Moonshot tool guide](https://github.com/MoonshotAI/Kimi-K2/blob/main/docs/tool_call_guidance.md) | A compatible Kimi-family tool-call format. |
| Shared ChatML | [Qwen formatting implementation](https://github.com/QwenLM/Qwen/blob/main/finetune.py) | Shared across implementations; no specific model attribution. |
| Shared assistant role tags | [ChatGLM prompt format](https://github.com/THUDM/ChatGLM3/blob/main/PROMPT_en.md) | Also used by other families; no specific model attribution. |
| Shared reasoning tags | [Qwen3 thinking modes](https://github.com/QwenLM/Qwen3/blob/main/README.md) | A reasoning convention shared with other models and human examples. |

Required paired markers indicate a serialization convention, not a verified
author, vendor signature or exact model version. Shared formats are supporting
clues below the flag threshold by themselves. A recognized family format can
produce an inferred family hint, and its documentation link travels with the
finding into the report. The extension does not discover hidden proprietary
fingerprints or promise detection of every model from the publication window.

Interface metadata is kept separate from model identity: ComfyUI supports many
families. A model checkpoint such as FLUX or Qwen-Image can take priority over its
front-end, while a text encoder such as Qwen3 must not be read as an image
generator. Explicit generation declarations are distinct from assistance,
negation and a credit naming a human. When separate clauses credit different
models, each can appear in the Tools report.

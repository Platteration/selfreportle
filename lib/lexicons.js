/*
 * lib/lexicons.js — per-language disclosure phrasing and LLM-typical wording.
 *
 * An EU reader meets AI disclosures in their own language, and the stylistic
 * tells of machine-written prose differ per language. Everything English-only
 * in the analyser reads as "no signal" on a German or French page, which is
 * the worst kind of wrong: silent.
 *
 * Two rules keep cross-language noise out:
 *   • Disclosure patterns for the page language AND English always run, because
 *     English disclosures appear on non-English pages all the time.
 *   • Stylometry runs only for the detected language. Applying the English
 *     lexicon to German prose would invent signals.
 *
 * Per-language lexicons are smaller than the English one, so they fire less
 * often. That is deliberate: under-reporting is the safer failure here.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.lexicons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Names for AI systems as each language writes them. */
  const AI_DE = '(?:KI|K\\.I\\.|künstliche[rn]? Intelligenz|generative[rn]? KI|Sprachmodell[s]?|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)';
  const AI_FR = "(?:IA|I\\.A\\.|intelligence artificielle|IA générative|modèle de langage|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)";
  const AI_ES = '(?:IA|I\\.A\\.|inteligencia artificial|IA generativa|modelo de lenguaje|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)';
  const AI_NL = '(?:AI|A\\.I\\.|kunstmatige intelligentie|generatieve AI|taalmodel|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)';
  const AI_IT = "(?:IA|I\\.A\\.|AI|intelligenza artificiale|IA generativa|modello linguistico|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)";
  const AI_PT = '(?:IA|I\\.A\\.|inteligência artificial|IA generativa|modelo de linguagem|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)';
  /* Polish inflects heavily, so endings are matched with an explicit letter
   * class: \w does not cover ą, ć, ę, ł, ń, ó, ś, ź, ż. */
  const PL = 'a-ząćęłńóśźż';
  const AI_PL = '(?:AI|SI|sztuczn[' + PL + ']{1,3}\\s+inteligencj[' + PL + ']{1,3}|model[' + PL + ']{0,3}\\s+j[ęe]zykow[' + PL + ']{1,3}|LLM|ChatGPT|GPT-?\\d[\\w.]*|Claude|Gemini|Copilot|Midjourney|DALL[·\\-\\s]?E|Stable Diffusion|Firefly)';

  const LANGUAGES = {
    de: {
      name: 'German',
      disclosures: [
        { level: 'generated', re: new RegExp('\\b(?:KI|A\\.?I\\.?)[-\\s]?(?:generiert|erstellt|erzeugt|geschrieben|verfasst)\\b', 'i') },
        { level: 'generated', re: new RegExp('\\b(?:erstellt|generiert|erzeugt|geschrieben|verfasst|übersetzt|zusammengefasst)\\s+(?:mit(?:hilfe)?|durch|von)\\s+(?:einer?\\s+|der\\s+)?' + AI_DE + '\\b', 'i') },
        { level: 'generated', re: /\bsynthetische[rs]?\s+(?:Medien|Bild|Inhalt|Video|Stimme)\b|\bdigital\s+erzeugt\b/i },
        { level: 'assisted', re: new RegExp('\\b(?:KI|A\\.?I\\.?)[-\\s](?:gestützt|unterstützt|assistiert|bearbeitet|optimiert)\\b|\\bmit\\s+(?:Hilfe|Unterstützung)\\s+(?:von\\s+)?' + AI_DE + '\\b', 'i') },
        { level: 'assisted', re: new RegExp('\\b' + AI_DE + '\\s+(?:wurde|wird|kam)\\s+(?:dabei\\s+)?(?:ein|zum Einsatz)', 'i') },
        { level: 'weak', re: /\bautomatisch\s+(?:generiert|erstellt|übersetzt|zusammengefasst)\b|\bmaschinell\s+übersetzt\b/i },
        { level: 'human', re: /\bvon\s+Menschen\s+(?:geschrieben|erstellt|verfasst|gemacht)\b|\bohne\s+(?:den\s+Einsatz\s+von\s+)?(?:KI|künstliche[rn]?\s+Intelligenz)\b|\bredaktionell\s+(?:erstellt|geprüft)\b|\bhandgeschrieben\b/i },
      ],
      tier1: [
        /\bin der heutigen (?:schnelllebigen|digitalen|vernetzten)\b/gi, /\bes ist wichtig(?:,| zu)\s?(?:zu\s)?(?:beachten|erwähnen|verstehen)\b/gi,
        /\bzusammenfassend l[äa]sst sich sagen\b/gi, /\btauchen wir ein\b/gi, /\bein tieferer? Einblick\b/gi,
        /\bganzheitlich\w*\b/gi, /\bnahtlos\w*\b/gi, /\bvielf[äa]ltig\w*\b/gi, /\brevolutionier\w+\b/gi, /\bbahnbrechend\w*\b/gi,
        /\bwegweisend\w*\b/gi, /\bmaßgeschneidert\w*\b/gi, /\bunverzichtbar\w*\b/gi, /\bin der Welt der\b/gi, /\bdie Landschaft (?:der|des)\b/gi,
        /\bes sei angemerkt\b/gi, /\bnicht nur\b[^.!?\n]{3,80}\bsondern auch\b/gi, /\bein entscheidender Faktor\b/gi,
        /\bspielt eine (?:entscheidende|wichtige|zentrale) Rolle\b/gi, /\bin diesem (?:Artikel|Beitrag) (?:werden wir|erfahren Sie)\b/gi,
        /\bfundiert\w*\b/gi, /\bfacettenreich\w*\b/gi, /\bbeleuchten\b/gi, /\bein wahres\b/gi, /\bFazit:/gi, /\bletztendlich\b/gi,
        /\bdar[üu]ber hinaus\b/gi, /\bein Muss f[üu]r\b/gi, /\bes lohnt sich\b/gi, /\bimmer weiter entwickelnd\w*\b/gi,
      ],
      tier2: [/\bzudem\b/gi, /\bferner\b/gi, /\bsomit\b/gi, /\bfolglich\b/gi, /\binsbesondere\b/gi, /\bzweifellos\b/gi, /\brobust\w*\b/gi, /\beffizient\w*\b/gi, /\boptimier\w+\b/gi, /\bumfassend\w*\b/gi, /\binnovativ\w*\b/gi, /\bdynamisch\w*\b/gi, /\bzahlreich\w*\b/gi, /\bentscheidend\w*\b/gi, /\bwesentlich\w*\b/gi],
      selfRefStrong: /\bals (?:ein )?(?:KI|Sprachmodell)\b|\bich bin eine? (?:KI|Sprachmodell)\b|\bals KI-Modell\b|\bnat[üu]rlich! hier (?:ist|sind)\b|\bgerne! hier (?:ist|sind)\b|\bhier (?:ist|sind) (?:ein|eine|der|die|das) (?:\w+ ){0,2}(?:Artikel|Blogbeitrag|Text|Version|Zusammenfassung|Entwurf)\b/i,
      selfRefMedium: /\bich hoffe,? das hilft\b|\blass(?:en Sie)? mich wissen\b|\bm[öo]chten Sie,? dass ich\b|\bbitte beachten Sie,? dass\b/i,
    },
    fr: {
      name: 'French',
      disclosures: [
        { level: 'generated', re: new RegExp("\\b(?:généré|créé|produit|rédigé|écrit|traduit|résumé)e?s?\\s+(?:par|avec|à l'aide d[eu']?)\\s*(?:une?\\s+|l')?" + AI_FR + '\\b', 'i') },
        { level: 'generated', re: /\bcontenus?\s+g[ée]n[ée]r[ée]s?\s+par\s+(?:l')?IA\b|\bimages?\s+g[ée]n[ée]r[ée]es?\s+par\s+(?:l')?IA\b|\bm[ée]dias?\s+synth[ée]tiques?\b/i },
        { level: 'assisted', re: new RegExp("\\b(?:assisté|aidé|augmenté|amélioré|édité)e?\\s+par\\s+(?:l')?" + AI_FR + "\\b|\\bavec l'aide\\s+d[eu']?\\s*(?:une?\\s+|l')?" + AI_FR + '\\b', 'i') },
        { level: 'weak', re: /\btraduit\s+automatiquement\b|\bg[ée]n[ée]r[ée]\s+automatiquement\b|\btraduction\s+automatique\b/i },
        { level: 'human', re: /\b[ée]crit\s+par\s+(?:des\s+)?humains?\b|\br[ée]dig[ée]\s+par\s+(?:nos\s+)?(?:journalistes|r[ée]dacteurs|humains)\b|\bsans\s+(?:recours\s+à\s+)?(?:l')?(?:IA|intelligence artificielle)\b|\b100\s?%\s+humain\b/i },
      ],
      tier1: [
        /\bdans le monde d'aujourd'hui\b/gi, /\bà l'ère (?:du|de la|numérique)\b/gi, /\bil est important de (?:noter|souligner|comprendre)\b/gi,
        /\bil convient de noter\b/gi, /\ben conclusion\b/gi, /\bpour conclure\b/gi, /\bplongeons\b/gi, /\bexplorons\b/gi,
        /\bincontournable\b/gi, /\brévolutionn\w+\b/gi, /\bpaysage (?:numérique|technologique|médiatique)\b/gi,
        /\bde plus en plus\b/gi, /\bune multitude de\b/gi, /\bjoue un rôle (?:crucial|essentiel|clé|majeur)\b/gi,
        /\bnon seulement\b[^.!?\n]{3,80}\bmais aussi\b/gi, /\bsur mesure\b/gi, /\btransformer? (?:votre|le monde)\b/gi,
        /\bau cœur de\b/gi, /\bvéritable\b/gi, /\bdans cet article,? (?:nous|vous)\b/gi, /\bà ne pas manquer\b/gi, /\bsans plus attendre\b/gi,
      ],
      tier2: [/\ben outre\b/gi, /\bpar ailleurs\b/gi, /\bde surcroît\b/gi, /\bainsi\b/gi, /\bnotamment\b/gi, /\bcertes\b/gi, /\brobuste\b/gi, /\boptimis\w+\b/gi, /\bcomplet\b/gi, /\binnovant\w*\b/gi, /\bdynamique\b/gi, /\bessentiel\w*\b/gi, /\bcrucial\w*\b/gi, /\bdivers\w*\b/gi],
      selfRefStrong: /\ben tant qu'(?:IA|intelligence artificielle|modèle de langage)\b|\bje suis une (?:IA|intelligence artificielle)\b|\bbien s[ûu]r ?! voici\b|\bvoici (?:un|une|le|la) (?:\w+ ){0,2}(?:article|texte|version|r[ée]sum[ée]|brouillon)\b/i,
      selfRefMedium: /\bj'espère que cela (?:vous )?aide\b|\bn'hésitez pas à\b|\bsouhaitez-vous que je\b|\bveuillez noter que\b/i,
    },
    es: {
      name: 'Spanish',
      disclosures: [
        { level: 'generated', re: new RegExp('\\b(?:generad|cread|producid|redactad|escrit|traducid|resumid)[oa]s?\\s+(?:por|con|mediante)\\s+(?:una?\\s+|la\\s+|el\\s+)?' + AI_ES + '\\b', 'i') },
        { level: 'generated', re: /\bcontenidos?\s+generad[oa]s?\s+por\s+(?:la\s+)?IA\b|\bmedios?\s+sint[ée]tic[oa]s?\b/i },
        { level: 'assisted', re: new RegExp('\\b(?:asistid|ayudad|mejorad|editad)[oa]s?\\s+(?:por|con)\\s+(?:la\\s+)?' + AI_ES + '\\b|\\bcon\\s+(?:la\\s+)?ayuda\\s+de\\s+(?:una?\\s+|la\\s+)?' + AI_ES + '\\b', 'i') },
        { level: 'weak', re: /\btraducid[oa]\s+autom[áa]ticamente\b|\bgenerad[oa]\s+autom[áa]ticamente\b|\btraducci[óo]n\s+autom[áa]tica\b/i },
        { level: 'human', re: /\bescrit[oa]\s+por\s+(?:seres\s+)?humanos?\b|\bredactad[oa]\s+por\s+(?:nuestr[oa]s\s+)?(?:periodistas|humanos|redactores)\b|\bsin\s+(?:uso\s+de\s+)?(?:IA|inteligencia artificial)\b|\b100\s?%\s+humano\b/i },
      ],
      tier1: [
        /\ben el mundo actual\b/gi, /\ben la era (?:digital|actual)\b/gi, /\bes importante (?:señalar|destacar|tener en cuenta|recordar)\b/gi,
        /\bcabe destacar\b/gi, /\ben conclusi[óo]n\b/gi, /\bpara concluir\b/gi, /\bsumerg[ií]\w*\b/gi, /\bexploremos\b/gi,
        /\bimprescindible\b/gi, /\brevolucionar?\w*\b/gi, /\bpanorama (?:digital|actual|tecnol[óo]gico)\b/gi,
        /\buna\s+(?:amplia\s+)?(?:gama|variedad)\s+de\b/gi, /\bjuega un papel (?:crucial|fundamental|clave)\b/gi,
        /\bno solo\b[^.!?\n]{3,80}\bsino tambi[ée]n\b/gi, /\ba medida\b/gi, /\ben el coraz[óo]n de\b/gi, /\bverdadero\b/gi,
        /\ben este art[íi]culo,? (?:exploraremos|veremos|descubrir[áa]s)\b/gi, /\bsin m[áa]s pre[áa]mbulos\b/gi,
      ],
      tier2: [/\badem[áa]s\b/gi, /\basimismo\b/gi, /\bpor otro lado\b/gi, /\bpor lo tanto\b/gi, /\bsin duda\b/gi, /\bespecialmente\b/gi, /\brobust\w*\b/gi, /\boptimiz\w+\b/gi, /\bcompleto\b/gi, /\binnovador\w*\b/gi, /\bdin[áa]mico\b/gi, /\besencial\b/gi, /\bcrucial\b/gi, /\bdiversos?\b/gi],
      selfRefStrong: /\bcomo (?:una )?(?:IA|inteligencia artificial|modelo de lenguaje)\b|\bsoy una? (?:IA|inteligencia artificial)\b|\b[¡!]?claro! aqu[íi] (?:tienes|est[áa])\b|\baqu[íi] (?:tienes|est[áa]) (?:un|una|el|la) (?:\w+ ){0,2}(?:art[íi]culo|texto|versi[óo]n|resumen|borrador)\b/i,
      selfRefMedium: /\bespero que (?:esto )?(?:te )?(?:sea [úu]til|ayude)\b|\bno dudes en\b|\b[¿?]quieres que\b|\bten en cuenta que\b/i,
    },
    nl: {
      name: 'Dutch',
      disclosures: [
        { level: 'generated', re: new RegExp('\\b(?:gegenereerd|gemaakt|geschreven|geproduceerd|vertaald|samengevat)\\s+(?:door|met(?:\\s+behulp\\s+van)?)\\s+(?:een\\s+)?' + AI_NL + '\\b', 'i') },
        { level: 'generated', re: /\bAI[-\s]?gegenereerd\w*\b|\bdoor\s+AI\s+gegenereerd\b|\bsynthetische\s+(?:media|content|beelden)\b/i },
        { level: 'assisted', re: new RegExp('\\bAI[-\\s]?(?:ondersteund|geassisteerd|bewerkt|geholpen)\\w*\\b|\\bmet\\s+(?:de\\s+)?hulp\\s+van\\s+(?:een\\s+)?' + AI_NL + '\\b', 'i') },
        { level: 'weak', re: /\bautomatisch\s+(?:gegenereerd|vertaald|samengevat)\b|\bmachinaal\s+vertaald\b/i },
        { level: 'human', re: /\bdoor\s+mensen\s+(?:geschreven|gemaakt)\b|\bzonder\s+(?:gebruik\s+van\s+)?AI\b|\b100\s?%\s+menselijk\b|\bredactioneel\s+(?:gemaakt|gecontroleerd)\b/i },
      ],
      tier1: [
        /\bin de wereld van vandaag\b/gi, /\bin het huidige (?:digitale )?landschap\b/gi, /\bhet is belangrijk om (?:op te merken|te beseffen)\b/gi,
        /\btot slot\b/gi, /\bsamenvattend\b/gi, /\blaten we (?:duiken|verkennen)\b/gi, /\bduik(?:en)? in\b/gi,
        /\bonmisbaar\b/gi, /\brevolutionair\w*\b/gi, /\bhet landschap van\b/gi, /\bnaadloos\w*\b/gi, /\bveelzijdig\w*\b/gi,
        /\bop maat gemaakt\b/gi, /\bspeelt een (?:cruciale|belangrijke|sleutel)rol\b/gi, /\bniet alleen\b[^.!?\n]{3,80}\bmaar ook\b/gi,
        /\bin dit artikel (?:bespreken|onderzoeken|leest)\b/gi, /\been schat aan\b/gi, /\bbaanbrekend\w*\b/gi,
      ],
      tier2: [/\bbovendien\b/gi, /\bdaarnaast\b/gi, /\btevens\b/gi, /\bderhalve\b/gi, /\bmet name\b/gi, /\bongetwijfeld\b/gi, /\brobuust\b/gi, /\boptimalis\w+\b/gi, /\buitgebreid\b/gi, /\binnovatief\b/gi, /\bdynamisch\b/gi, /\bessentieel\b/gi, /\bcruciaal\b/gi, /\bdiverse\b/gi],
      selfRefStrong: /\bals (?:een )?(?:AI|taalmodel)\b|\bik ben een (?:AI|taalmodel)\b|\bnatuurlijk! hier (?:is|zijn)\b|\bhier (?:is|zijn) (?:een|de|het) (?:\w+ ){0,2}(?:artikel|tekst|versie|samenvatting|concept)\b/i,
      selfRefMedium: /\bik hoop dat dit helpt\b|\blaat me weten\b|\bwil je dat ik\b|\blet op dat\b/i,
    },
    it: {
      name: 'Italian',
      disclosures: [
        { level: 'generated', re: new RegExp("\\b(?:generat|creat|prodott|scritt|redatt|tradott|riassunt)[oaie]\\s+(?:da|con|mediante)(?:ll['a])?\\s*(?:un[a']?\\s+)?" + AI_IT + '\\b', 'i') },
        { level: 'generated', re: /\bcontenut[oi]\s+generat[oi]\s+(?:dall')?(?:IA|AI)\b|\bmedia\s+sintetic[oi]\b/i },
        { level: 'assisted', re: new RegExp("\\b(?:assistit|aiutat|migliorat|modificat)[oaie]\\s+(?:da|con)(?:ll['a])?\\s*" + AI_IT + "\\b|\\bcon\\s+l'aiuto\\s+(?:di|dell')\\s*" + AI_IT + '\\b', 'i') },
        { level: 'weak', re: /\btradott[oi]\s+automaticamente\b|\bgenerat[oi]\s+automaticamente\b|\btraduzione\s+automatica\b/i },
        { level: 'human', re: /\bscritt[oi]\s+da\s+(?:esseri\s+)?uman[i]\b|\bredatt[oi]\s+da\s+(?:nostri\s+)?(?:giornalisti|redattori)\b|\bsenza\s+(?:l'uso\s+di\s+)?(?:IA|intelligenza artificiale)\b|\b100\s?%\s+umano\b/i },
      ],
      tier1: [
        /\bnel mondo di oggi\b/gi, /\bnell'era (?:digitale|attuale)\b/gi, /\b[èe] importante (?:notare|sottolineare|ricordare)\b/gi,
        /\bvale la pena (?:notare|sottolineare)\b/gi, /\bin conclusione\b/gi, /\bimmergiamoci\b/gi, /\besploriamo\b/gi,
        /\bimprescindibile\b/gi, /\brivoluzionar\w+\b/gi, /\bpanorama (?:digitale|attuale|tecnologico)\b/gi,
        /\bun'ampia (?:gamma|varietà) di\b/gi, /\bsvolge un ruolo (?:cruciale|fondamentale|chiave)\b/gi,
        /\bnon solo\b[^.!?\n]{3,80}\bma anche\b/gi, /\bsu misura\b/gi, /\bnel cuore di\b/gi, /\bveri?[oe]?\b/gi,
        /\bin questo articolo,? (?:esploreremo|vedremo|scoprirai)\b/gi, /\bsenza indugio\b/gi, /\bsenza soluzione di continuità\b/gi,
      ],
      tier2: [/\binoltre\b/gi, /\baltres[ìi]\b/gi, /\bpertanto\b/gi, /\bdunque\b/gi, /\bin particolare\b/gi, /\bsenza dubbio\b/gi, /\brobusto\b/gi, /\bottimizz\w+\b/gi, /\bcompleto\b/gi, /\binnovativo\b/gi, /\bdinamico\b/gi, /\bessenziale\b/gi, /\bcruciale\b/gi, /\bdiversi\b/gi],
      selfRefStrong: /\bin quanto (?:IA|intelligenza artificiale|modello linguistico)\b|\bsono un'?(?:IA|intelligenza artificiale)\b|\bcerto! ecco\b|\becco (?:un|una|il|la) (?:\w+ ){0,2}(?:articolo|testo|versione|riassunto|bozza)\b/i,
      selfRefMedium: /\bspero che (?:questo )?(?:ti )?(?:sia utile|aiuti)\b|\bnon esitare a\b|\bvuoi che io\b|\bnota che\b/i,
    },
    pt: {
      name: 'Portuguese',
      disclosures: [
        { level: 'generated', re: new RegExp('\\b(?:gerad|criad|produzid|escrit|redigid|traduzid|resumid)[oa]s?\\s+(?:por|com|mediante)\\s+(?:uma?\\s+|a\\s+|o\\s+)?' + AI_PT + '\\b', 'i') },
        { level: 'generated', re: /\bconte[úu]dos?\s+gerad[oa]s?\s+por\s+(?:IA|intelig[êe]ncia artificial)\b|\bm[íi]dias?\s+sint[ée]tic[oa]s?\b/i },
        { level: 'assisted', re: new RegExp('\\b(?:assistid|auxiliad|melhorad|editad)[oa]s?\\s+(?:por|com)\\s+(?:a\\s+)?' + AI_PT + '\\b|\\bcom\\s+(?:a\\s+)?ajuda\\s+d[aeo]\\s*' + AI_PT + '\\b', 'i') },
        { level: 'weak', re: /\btraduzid[oa]\s+automaticamente\b|\bgerad[oa]\s+automaticamente\b|\btradu[çc][ãa]o\s+autom[áa]tica\b/i },
        { level: 'human', re: /\bescrit[oa]\s+por\s+(?:seres\s+)?humanos?\b|\bsem\s+(?:o\s+uso\s+de\s+)?(?:IA|intelig[êe]ncia artificial)\b|\b100\s?%\s+humano\b/i },
      ],
      tier1: [
        /\bno mundo de hoje\b/gi, /\bna era (?:digital|atual)\b/gi, /\b[ée] importante (?:notar|destacar|lembrar)\b/gi,
        /\bvale (?:a pena )?(?:notar|destacar)\b/gi, /\bem conclus[ãa]o\b/gi, /\bvamos (?:mergulhar|explorar)\b/gi,
        /\bindispens[áa]vel\b/gi, /\brevolucionar?\w*\b/gi, /\bpanorama (?:digital|atual)\b/gi, /\buma ampla (?:gama|variedade) de\b/gi,
        /\bdesempenha um papel (?:crucial|fundamental|chave)\b/gi, /\bn[ãa]o apenas\b[^.!?\n]{3,80}\bmas tamb[ée]m\b/gi,
        /\bsob medida\b/gi, /\bno cora[çc][ãa]o de\b/gi, /\bneste artigo,? (?:exploraremos|veremos|voc[êe] vai)\b/gi,
      ],
      tier2: [/\bal[ée]m disso\b/gi, /\bademais\b/gi, /\bportanto\b/gi, /\bassim\b/gi, /\bem particular\b/gi, /\bsem d[úu]vida\b/gi, /\brobusto\b/gi, /\botimiz\w+\b/gi, /\bcompleto\b/gi, /\binovador\w*\b/gi, /\bdin[âa]mico\b/gi, /\bessencial\b/gi, /\bcrucial\b/gi, /\bdiversos\b/gi],
      selfRefStrong: /\bcomo (?:uma )?(?:IA|intelig[êe]ncia artificial|modelo de linguagem)\b|\bsou uma? (?:IA|intelig[êe]ncia artificial)\b|\bclaro! aqui est[áa]\b|\baqui est[áa] (?:um|uma|o|a) (?:\w+ ){0,2}(?:artigo|texto|vers[ãa]o|resumo|rascunho)\b/i,
      selfRefMedium: /\bespero que (?:isso )?ajude\b|\bfique [àa] vontade para\b|\bvoc[êe] gostaria que eu\b|\bobserve que\b/i,
    },
    pl: {
      name: 'Polish',
      disclosures: [
        { level: 'generated', re: new RegExp('\\b(?:wygenerowan|stworzon|napisan|przet[łl]umaczon|podsumowan)[' + PL + ']{1,3}\\s+(?:przez|za\\s+pomoc[ąa])\\s+' + AI_PL, 'i') },
        { level: 'generated', re: /\btre[śs][ćc]i?\s+wygenerowan\w+\s+przez\s+(?:AI|SI|sztuczn\w+ inteligencj\w+)\b|\bmedia\s+syntetyczne\b/i },
        { level: 'assisted', re: new RegExp('\\b(?:wspomagan|wspieran|edytowan|ulepszon)[' + PL + ']{1,3}\\s+przez\\s+' + AI_PL + '|\\bz\\s+pomoc[ąa]\\s+' + AI_PL, 'i') },
        { level: 'weak', re: /\bautomatycznie\s+(?:wygenerowan\w+|przet[łl]umaczon\w+)\b|\bt[łl]umaczenie\s+maszynowe\b/i },
        { level: 'human', re: /\bnapisan[a-ząćęłńóśźż]{1,3}\s+przez\s+(?:cz[łl]owieka|ludzi)\b|\bbez\s+(?:u[żz]ycia\s+)?(?:AI|SI|sztucznej\s+inteligencji)\b|\bw\s+100\s?%\s+ludzk[a-ząćęłńóśźż]{1,3}\b/i },
      ],
      tier1: [
        /\bw dzisiejszym (?:szybko zmieniaj[ąa]cym si[ęe]|cyfrowym) [śs]wiecie\b/gi, /\bwarto (?:zauwa[żz]y[ćc]|podkre[śs]li[ćc]|pami[ęe]ta[ćc])\b/gi,
        /\bpodsumowuj[ąa]c\b/gi, /\bzanurzmy si[ęe]\b/gi, /\bniezb[ęe]dn\w+\b/gi, /\brewolucjonizuj\w+\b/gi,
        /\bkrajobraz (?:cyfrowy|technologiczny)\b/gi, /\bszerok[ąa] gam[ęe]\b/gi, /\bodgrywa (?:kluczow[ąa]|istotn[ąa]) rol[ęe]\b/gi,
        /\bnie tylko\b[^.!?\n]{3,80}\bale tak[żz]e\b/gi, /\bszyt\w+ na miar[ęe]\b/gi, /\bw tym artykule (?:omówimy|dowiesz si[ęe])\b/gi,
      ],
      tier2: [/\bponadto\b/gi, /\bco wi[ęe]cej\b/gi, /\bzatem\b/gi, /\bw szczególno[śs]ci\b/gi, /\bbez w[ąa]tpienia\b/gi, /\bkompleksow\w+\b/gi, /\binnowacyjn\w+\b/gi, /\bdynamiczn\w+\b/gi, /\bkluczow\w+\b/gi, /\bistotn\w+\b/gi, /\bró[żz]norodn\w+\b/gi],
      selfRefStrong: /\bjako (?:AI|sztuczna inteligencja|model j[ęe]zykowy)\b|\bjestem (?:AI|sztuczn[ąa] inteligencj[ąa])\b|\boczywi[śs]cie! oto\b|\boto (?:artyku[łl]|tekst|wersja|podsumowanie)\b/i,
      selfRefMedium: /\bmam nadziej[ęe],? [żz]e (?:to )?pomo[żz]e\b|\bdaj zna[ćc]\b|\bczy chcesz,? [żz]ebym\b|\bnale[żz]y pami[ęe]ta[ćc]\b/i,
    },
  };

  /* Function words that are common in one language and rare in the others.
   * Enough to pick a lexicon; not a general-purpose language identifier. */
  const MARKERS = {
    en: /\b(?:the|and|of|to|is|that|with|for|are|this|from|which|have|been|were)\b/gi,
    de: /\b(?:und|der|die|das|den|dem|des|ist|nicht|auch|eine|einen|werden|sich|wird|oder|aber)\b/gi,
    fr: /\b(?:les|des|une|dans|pour|avec|est|sont|que|qui|plus|cette|nous|vous|leur|mais)\b/gi,
    es: /\b(?:los|las|una|del|para|con|por|que|más|este|esta|son|pero|como|todo|entre)\b/gi,
    nl: /\b(?:het|een|van|voor|met|zijn|niet|maar|deze|worden|wordt|ook|door|naar|over)\b/gi,
    it: /\b(?:che|non|per|con|una|dei|delle|sono|come|anche|questo|questa|nella|degli|alla)\b/gi,
    pt: /\b(?:que|não|para|com|uma|dos|das|são|como|também|este|esta|pelo|pela|mais)\b/gi,
    pl: /\b(?:nie|się|jest|oraz|który|która|które|tego|przez|jako|może|bardzo|tylko|wszystkie)\b/gi,
  };

  /*
   * Picks a language for the analyser. A declared lang attribute wins when it
   * names a language we have a lexicon for; otherwise the text is sampled.
   * Returns { code, source, confidence } with code null when nothing is clear,
   * because guessing wrong is worse than not guessing.
   */
  function detectLanguage(text, declared) {
    const d = String(declared || '').toLowerCase().slice(0, 2);
    if (d && (LANGUAGES[d] || d === 'en')) return { code: d, source: 'declared', confidence: 1 };
    const sample = String(text || '').slice(0, 20000);
    const words = (sample.match(/[\p{L}]+/gu) || []).length;
    if (words < 40) return { code: d || null, source: d ? 'declared' : 'none', confidence: 0 };
    const scores = {};
    for (const [code, re] of Object.entries(MARKERS)) {
      scores[code] = ((sample.match(re) || []).length / words) * 100;
    }
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [top, topScore] = ranked[0];
    const runnerUp = ranked[1] ? ranked[1][1] : 0;
    if (topScore < 3 || topScore < runnerUp * 1.5) return { code: d || null, source: d ? 'declared' : 'none', confidence: 0 };
    return { code: top, source: 'detected', confidence: Math.min(1, topScore / 12) };
  }

  function get(code) { return LANGUAGES[code] || null; }
  function supported() { return ['en', ...Object.keys(LANGUAGES)]; }
  function nameOf(code) { return code === 'en' ? 'English' : (LANGUAGES[code] ? LANGUAGES[code].name : null); }

  return { LANGUAGES, MARKERS, detectLanguage, get, supported, nameOf };
});
